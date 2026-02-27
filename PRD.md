# Product Requirements Document
## LiveLocks by PropPulse — MLB Baseball Expansion

**Version**: 1.0  
**Checkpoint**: `b9f431cd22f951b4f7aef34657876ee01dcdc336`  
**Date**: February 2026  
**Status**: Pre-implementation (use checkpoint above to revert if MLB implementation breaks anything)

---

## 1. Product Overview

LiveLocks is a live sports analytics tool that helps sports bettors make sharper in-game prop decisions using real-time data, predictive modeling, and correlation-aware parlay construction. The current product covers NBA. This document defines the requirements for expanding to **MLB Baseball**.

### 1.1 Current NBA Feature Set (Stable Baseline)

- Live game strip (ESPN scoreboard, 30s refresh)
- Clickable live box score with auto-fill into the calculator
- Probability engine: blends observed rate (70%) + season baseline (30%), adjusted for defense, pace, foul trouble
- Sportsbook odds integration (The Odds API — DraftKings, FanDuel, Hard Rock)
- Parlay builder with correlation engine and implied odds
- Sportsbook deeplinks
- Halftime best plays scanner
- JWT authentication + session cookies
- Stripe subscriptions ($25/mo NBA, $50/mo All Sports)
- Free tier: 10 probability calculations
- Admin panel: user management, tier overrides, feedback inbox

---

## 2. MLB Expansion Goals

### 2.1 Supported Prop Types (Phase 1)
1. **Hits** — Batter total hits in game
2. **Total Bases** — Batter total bases (1B=1, 2B=2, 3B=3, HR=4)
3. **Strikeouts (Batter)** — Times a batter strikes out
4. **Home Runs** — Batter hits a home run (binary, but treated as a low-line prop)

### 2.2 Out of Scope for Phase 1
- Pitcher strikeout props (Phase 2)
- RBIs, walks, stolen bases (Phase 2)
- Other sports (NFL, NHL, NBA expansion etc.)

---

## 3. Data Sources

### 3.1 Primary: MLB.com / ESPN (Free, No Key Required)
- **Live box scores**: `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/summary?event={gameId}`
- **Live scoreboard**: `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard`
- **Use for**: live game state (inning, outs, score), current batter/pitcher stats in-game

### 3.2 Season Stats: Baseball Savant (scrape, free)
- **URL**: `https://baseballsavant.mlb.com/statcast_search/csv?type=batter&hfStat=&player_type=batter&...`
- **CSV endpoint**: Statcast search CSV export (public, no auth required)
- **Scrape for**:
  - Batter `avg_hit_speed` (exit velocity)
  - `launch_angle_avg`
  - `hard_hit_percent`
  - `xba` (expected batting average)
  - `xslg` (expected slugging — proxy for total bases)
  - `k_percent` (strikeout rate)
  - `bb_percent`
  - `woba`, `xwoba`
  - Season hits, AB, HR, total bases per game (derived)

### 3.3 Matchup Context: Baseball Savant Pitcher vs Batter
- **URL**: `https://baseballsavant.mlb.com/statcast_search?player_type=batter&pitchers_lookup[]={pitcherId}&batters_lookup[]={batterId}&...`
- **Scrape for**: career H, K, HR, AB in matchup vs this specific pitcher today
- Used to adjust probability when the batter has a strong or weak historical tendency vs the starter

### 3.4 Weather: Open-Meteo (Free, No Key Required)
- **URL**: `https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lng}&current_weather=true`
- **Ballpark coordinates**: stored in a lookup table (30 MLB stadiums)
- **Weather factors**:
  - Wind speed + direction (affects fly balls / home run probability)
  - Temperature (cold air = less carry on fly balls)
  - Precipitation (game delay / cancellation risk)
- Wind blowing **out** to CF at >10 mph = +5–10% HR probability boost
- Wind blowing **in** from CF = -5–10% HR probability reduction
- Temperature < 50°F = -5% total bases / HR

### 3.5 Pitcher Data: Baseball Savant Pitcher Leaderboard
- **URL**: `https://baseballsavant.mlb.com/statcast_search/csv?type=pitcher&...`
- **Scrape for** (opposing pitcher stats relevant to batter props):
  - `avg_velocity` (starter average fastball speed)
  - `k_percent` (pitcher strikeout rate — affects batter K prop)
  - `bb_percent`
  - `hard_hit_allowed_percent`
  - `last_pitch_type` (most recent pitch thrown — from live box score)
  - `pitch_count` (current count from live box score)
  - `era`, `whip`, `ops_against`

### 3.6 BallparkPal / Ballpark Factors (scrape or static table)
- Ballpark run/HR/hit factor per park (1.0 = average)
- Example: Coors Field HR factor = 1.30, Petco Park = 0.87
- Store as a static lookup table (30 parks × 3 factors: hits, HR, strikeouts)
- Update once per season (static is fine — park factors barely change mid-season)

---

## 4. Live Box Score Display

### 4.1 Batter Row (per batter in game lineup)
| Field | Source |
|-------|--------|
| Name | ESPN box score |
| AB | ESPN live |
| H | ESPN live |
| HR | ESPN live |
| RBI | ESPN live |
| K | ESPN live |
| BB | ESPN live |
| Total Bases (computed) | ESPN live |
| Exit Velo (avg game) | Baseball Savant season avg (cached) |
| Launch Angle (avg) | Baseball Savant season avg (cached) |
| Matchup H/AB vs today's pitcher | Baseball Savant career splits |

### 4.2 Pitcher Display (today's starter + current pitcher)
| Field | Source |
|-------|--------|
| Name | ESPN lineup |
| Pitch Count | ESPN live box score |
| Last Pitch Type | ESPN live |
| Avg Velocity (season) | Baseball Savant |
| K% | Baseball Savant |
| ERA | Baseball Savant / ESPN |
| WHIP | Baseball Savant / ESPN |

---

## 5. Probability Engine — MLB

### 5.1 Hits
```
baseHitsPerAB = player.seasonH / player.seasonAB  (batting average)
adjustedBA = baseHitsPerAB × pitcherFactor × parkFactor × tempFactor
remainingAB = estimatedRemainingAB(currentInning, lineupSlot)  // avg 3.8 AB/9 innings
expectedHits = currentH + (remainingAB × adjustedBA)
probability = normal_cdf(line, expectedHits, stddev)
```

### 5.2 Total Bases
```
xSLGPerAB = player.xslg / 3.0  // normalize to per-AB
adjustedSLG = xSLGPerAB × pitcherFactor × parkFactor × windFactor
expectedTB = currentTB + (remainingAB × adjustedSLG)
probability = normal_cdf(line, expectedTB, stddev)
```

### 5.3 Strikeouts (Batter)
```
kRate = player.kPercent  // 0–1
adjustedKRate = kRate × (pitcher.kPercent / leagueAvgK) × parkKFactor
expectedK = currentK + (remainingAB × adjustedKRate)
probability = normal_cdf(line, expectedK, stddev)
```

### 5.4 Home Runs
```
hrPerAB = player.seasonHR / player.seasonAB
adjustedHRRate = hrPerAB × pitcherHRRate × parkHRFactor × windFactor × tempFactor
expectedHR = currentHR + (remainingAB × adjustedHRRate)
probability = poisson_cdf(line, expectedHR)  // Poisson for rare events
```

### 5.5 Weather Adjustments
```
windFactor (HR/TB) = 1.0 + windEffect(speed, direction, ballparkOrientation)
  wind out CF >10mph: +0.08
  wind out CF >20mph: +0.15
  wind in CF >10mph: -0.08
  wind in CF >20mph: -0.12

tempFactor = 1.0 - max(0, (65 - tempF) * 0.003)  // ~0.3% reduction per degree below 65°F
```

### 5.6 Matchup Adjustment
```
matchupBA = careerH / careerAB  (vs today's pitcher, min 10 AB to use)
if sampleSize >= 10:
  finalBA = seasonBA * 0.7 + matchupBA * 0.3
else:
  finalBA = seasonBA  // small sample, ignore
```

---

## 6. UI/UX Requirements

### 6.1 Dashboard Changes
- Add "MLB" sport tab alongside "NBA" tab (gated behind "All Sports" subscription)
- Separate game strip for MLB games (ESPN MLB scoreboard)
- Reuse the same calculator card layout — same form structure, MLB-specific stat types
- Live box score panel: shows lineup card with batter stats + pitcher card above

### 6.2 Baseball-Specific Inputs
| Input | Type | Notes |
|-------|------|-------|
| Player | Select | Batters from today's live MLB lineups |
| Opponent | Select (auto from game) | Pitcher's team |
| Stat Type | Select | Hits / Total Bases / Strikeouts / Home Runs |
| Current Stat | Number | Batter's current H/TB/K/HR from live box score |
| Current AB | Number | Auto-filled from box score |
| Current Inning | Number | Auto-filled from game state |
| Live Line | Number | From Odds API (if available) |

### 6.3 Weather Widget
- Shown in the result panel when MLB game is selected
- Displays: temperature, wind speed + direction, precipitation
- Wind direction indicator relative to ballpark (blowing in/out/crosswind)
- Color-coded: green = favorable, yellow = neutral, red = unfavorable

### 6.4 Pitcher Card
- Appears when a game is selected, above the batter box score
- Shows: pitcher name, pitch count, last pitch type, avg velocity, K%, ERA, WHIP

### 6.5 Batter Detail Row
- Clicking a batter in the box score auto-fills: current stat, AB, and pre-loads matchup data
- Exit velo and launch angle shown as secondary info badges on the row

---

## 7. Backend Architecture

### 7.1 New Database Tables

#### `mlb_players`
```typescript
{
  id: serial primary key,
  name: text,
  mlbId: text unique,  // MLB.com player ID
  team: text,          // 3-letter abbr (NYY, BOS, etc.)
  position: text,
  batSide: text,       // L / R / S
  throwSide: text,
  avgMinutes: null,    // not used for baseball
  // Season stats from Baseball Savant
  avgExitVelo: decimal,
  avgLaunchAngle: decimal,
  hardHitPct: decimal,
  xba: decimal,
  xslg: decimal,
  kPercent: decimal,
  bbPercent: decimal,
  woba: decimal,
  seasonH: integer,
  seasonAB: integer,
  seasonHR: integer,
  seasonTB: integer,
  seasonK: integer,
  statsUpdatedAt: timestamp,
}
```

#### `mlb_pitchers`
```typescript
{
  id: serial primary key,
  name: text,
  mlbId: text unique,
  team: text,
  throwSide: text,
  avgVelocity: decimal,
  kPercent: decimal,
  bbPercent: decimal,
  era: decimal,
  whip: decimal,
  hrPer9: decimal,
  hardHitAllowedPct: decimal,
  statsUpdatedAt: timestamp,
}
```

#### `mlb_ballparks`
```typescript
{
  id: serial primary key,
  team: text unique,   // home team abbr
  name: text,
  latitude: decimal,
  longitude: decimal,
  hitFactor: decimal,  // 1.0 = average
  hrFactor: decimal,
  kFactor: decimal,
  windOrientation: integer,  // degrees — direction home plate faces
}
```

### 7.2 New API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/mlb/games` | Live MLB scoreboard from ESPN |
| `GET` | `/api/mlb/live-stats/:gameId` | MLB box score + pitcher info |
| `GET` | `/api/mlb/weather/:team` | Weather for ballpark by home team |
| `GET` | `/api/mlb/players` | All batters (with season stats) |
| `POST` | `/api/mlb/calculate` | MLB probability calculation |
| `POST` | `/api/mlb/sync-stats` | Admin-triggered Baseball Savant scrape |

### 7.3 Data Refresh Strategy
- **Live box score**: same as NBA — fetched on demand, 30s cache
- **Season stats (Baseball Savant)**: refresh daily at 6am ET (or on admin trigger)
- **Weather**: refresh every 15 minutes per ballpark (cached by team + timestamp)
- **Pitcher stats**: refresh daily
- **Matchup splits**: fetched on demand when a game + player is selected (30-min cache)

---

## 8. Subscription Gating

MLB is part of the **"All Sports"** tier ($50/mo). Free and NBA-only users see the MLB tab locked with an upgrade prompt. Admin accounts have full access.

```
Tier null  → Calculator gated (10 free plays total, NBA + MLB shared pool)
Tier "nba" → NBA unlimited, MLB locked
Tier "all" → NBA + MLB unlimited
isAdmin    → Everything unlocked
```

---

## 9. Implementation Order

1. **Schema**: Add `mlb_players`, `mlb_pitchers`, `mlb_ballparks` tables
2. **Static data**: Seed 30 ballparks with coordinates, factors, and wind orientation
3. **ESPN scraper**: `/api/mlb/games` and `/api/mlb/live-stats/:gameId`
4. **Weather service**: Open-Meteo integration
5. **Baseball Savant scraper**: Season stats for batters + pitchers
6. **Probability engine**: `server/mlbCalculator.ts`
7. **New API routes**: All `/api/mlb/*` endpoints
8. **Frontend**: MLB tab, game strip, box score panel, weather widget, pitcher card, calculator form
9. **Parlay integration**: MLB picks added to existing parlay builder (correlation engine extended)
10. **Testing**: Full e2e across mobile and desktop

---

## 10. Risk & Mitigations

| Risk | Mitigation |
|------|-----------|
| Baseball Savant blocks scraping | Rate-limit requests; cache aggressively; fall back to season stats only |
| Weather API unreliable | Default weather factors to 1.0 (neutral) if request fails |
| Live MLB data lag from ESPN | Add "last updated" timestamp; show stale data warning if > 5 min old |
| MLB prop lines not available on Odds API free tier | Degrade gracefully — show calculated probability without sportsbook line |
| Small matchup sample sizes (< 10 AB) | Fall back to season stats only when sample < 10 AB |
| Replit cold starts wiping cache | All caches use server memory with TTL; acceptable to re-fetch on restart |

---

## 11. Rollback

**Checkpoint to revert to**: `b9f431cd22f951b4f7aef34657876ee01dcdc336`

This checkpoint represents the stable NBA-only release with:
- JWT auth
- Mobile-optimized header and parlay slip
- Accurate live game period/clock in calculator
- Twitter share button with `@proppulsebets` attribution
- Full Stripe subscription flow
- Admin panel
- All e2e tests passing on mobile and desktop

To revert: ask the agent to roll back to this checkpoint, or use the Replit checkpoint history.
