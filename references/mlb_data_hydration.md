# MLB Data Hydration & Persistence — Reference

This document describes how MLB data flows through the system. Read this
before touching any sync function, cache, or signal builder. The rules here
prevent regressions that silently break signal accuracy.

---

## 1. Architecture Overview

```
API Sources ──► Sync Functions ──► In-Memory Caches ──► Engine Input ──► Signal Output ──► Frontend
```

All MLB data lives in two in-memory cache trees during a game's lifetime:

| Cache              | Keyed By     | Contents                                      |
|--------------------|-------------|-----------------------------------------------|
| `mlbGameCache`     | `gameId`    | gameState, contactData, pitcherContext, weather, bullpen, gameBoxScore |
| `mlbPlayerCache`   | `playerId`  | pitcherSeasonStats, batterRollingStats, bvpMatchups |

Plus two auxiliary caches:

| Cache              | Location             | TTL     | Purpose                          |
|--------------------|---------------------|---------|----------------------------------|
| `savantCache`      | `dataSources.ts`    | 4 hours | Baseball Savant season Statcast  |
| `openMeteoCache`   | `dataPullService.ts`| 30 min  | Pre-game weather fallback        |

---

## 2. Poll Cycle Sequence

Every 10 seconds, for each active game, `_pollGameInner` runs:

```
1. await syncGameState(statsPk, gameId)       ← inning, outs, runners, lineup, pitcher
2. await syncGameBoxScore(statsPk, gameId)    ← player H/HR/AB/BB/SO/TB/RBI
3. await syncContactData(statsPk, gameId)     ← BIP hitData + Savant enrichment (MERGE)
4. await syncPitcherContext(statsPk, gameId)  ← pitch mix, velocity, TTO

5. In parallel (Promise.allSettled):
   ├── syncPitcherSeasonStats(pitcherId)      ← ERA, WHIP, K/9, BB/9
   ├── syncBatterRollingStats(batterId) × N   ← L7/L15/L30 avg, HR rate
   ├── syncBvPMatchup(batterId, pitcherId) × N← historical AB/H/HR/K vs pitcher
   └── syncSavantSeasonForLineup(gameId)      ← xBA, xSLG, EV, barrel%, batSpeed (PATCH)
```

Steps 1-4 are sequential (each `await`s). Step 5 runs in parallel after 1-4
complete. This ordering guarantees `syncContactData` finishes writing the
cache before `syncSavantSeasonForLineup` patches it.

---

## 3. Data Sources & What They Provide

### Per-Game Sources (stored in `mlbGameCache`)

| Source | Sync Function | Fields Populated |
|--------|--------------|-----------------|
| MLB Stats API `/feed/live` | `syncGameState` | inning, outs, runners, battingOrder, currentBatter, pitcherInGame, pitchCount, TTO, scores |
| MLB Stats API `/boxscore` | `syncGameBoxScore` | per-player hits, HR, AB, BB, RBI, SO, TB, runs |
| MLB Stats API play-by-play | `syncContactData` | priorABResults (EV, LA, distance, outcome, pitchType), latest EV/LA per player |
| Baseball Savant CSV | `syncContactData` + `syncSavantSeasonForLineup` | xBA, xSLG, avgBatSpeed, avgSwingLength, hardHitPct, barrelPct, season EV/LA |
| MLB Stats API pitch data | `syncPitcherContext` | pitch mix, avg velocity, velocity drop, TTO |
| MLB Stats API + OpenMeteo | `syncWeather` / `syncOpenMeteoWeather` | temperature, wind speed/direction, humidity, venue |
| MLB Stats API reliever box | `syncBullpenUsage` | bullpen ERA, 3-day usage, reliever count |

### Per-Player Sources (stored in `mlbPlayerCache`)

| Source | Sync Function | Fields | TTL |
|--------|--------------|--------|-----|
| MLB Stats API season stats | `syncPitcherSeasonStats` | ERA, WHIP, K/9, BB/9, IP, W, L | 30 min |
| MLB Stats API game log | `syncBatterRollingStats` | L7/L15/L30 avg/OPS, season avg, HR rate | 20 min |
| MLB Stats API vs-player | `syncBvPMatchup` | career AB/H/HR/K/AVG/OPS vs specific pitcher | 60 min |

### Savant Season Data (stored in `savantCache` + merged into `contactData`)

| Source | Function | Fields | TTL |
|--------|----------|--------|-----|
| Baseball Savant statcast_search CSV | `fetchBaseballSavantData` | xBA, xSLG, season EV, LA, hardHitRate, barrelRate, batSpeed, swingLength, pitchMix | 4 hours |
| MLB Stats API (fallback) | `fetchBaseballSavantData` catch block | BA, SLG (as xBA/xSLG proxies) | 4 hours |

---

## 4. Critical Persistence Rules

### RULE 1: Never Overwrite — Always Merge Contact Data

`syncContactData` rebuilds BIP (ball-in-play) events from the live feed
every cycle. Before writing to cache, it MUST:

1. Read existing cache: `const existing = mlbGameCache.contactData[gameId]?.byPlayerId ?? {}`
2. For each player in fresh data: carry forward any non-null Savant fields
   (xBA, xSLG, exitVelocity, hardHitPct, barrelPct, avgBatSpeed, avgSwingLength)
   from the previous cache entry when the fresh value is null
3. Carry forward players from existing cache not present in fresh data
   (e.g. pinch hitters enriched by pre-hydration but not yet in play events)

```
WRONG:  mlbGameCache.contactData[gameId] = { byPlayerId, fetchedAt }
RIGHT:  merge existing → fresh → write
```

### RULE 2: Savant Enrichment Is Selective

Only fetch Savant data for players still missing it. The filter:
- Both xBA AND xSLG are null, OR
- All three of avgBatSpeed, barrelPct, hardHitPct are null

This prevents re-fetching for players already enriched and avoids
wasting API calls / hitting rate limits.

### RULE 3: Never Overwrite Valid Cache with Nulls

When an API returns empty splits or no data:
- If valid cached data exists → refresh the `fetchedAt` timestamp but
  keep the existing data values
- Only write null defaults if no cached data exists at all

This applies to: `syncPitcherSeasonStats`, `syncBatterRollingStats`,
`syncBvPMatchup`.

### RULE 4: Stale Data > No Data

When a fetch fails (network error, timeout, rate limit):
- Return stale cached data if available (e.g. `savantCache` stale fallback)
- Refresh `fetchedAt` on existing cache to prevent immediate re-fetch retry
- Never silently return nulls when good data existed moments ago

### RULE 5: Savant Cache TTL = 4 Hours

Season-level Statcast data (xBA, xSLG, barrel%, etc.) changes slowly.
A 30-min TTL caused excessive re-fetching and data loss when Savant was
rate-limited. 4 hours is appropriate for season stats.

---

## 5. How Data Reaches Signals

The orchestrator builds `MLBPropInput` for each batter × market:

```typescript
contactQuality: {
  exitVelocity      ← playerContact.exitVelocity (max game EV from BIP)
  launchAngle       ← playerContact.launchAngle
  hitDistance        ← playerContact.hitDistance
  hardHitRateSeason ← playerContact.hardHitPct / 100 (from Savant)
  barrelRateProxySeason ← playerContact.barrelPct / 100 (from Savant)
  avgBatSpeed       ← playerContact.avgBatSpeed (from Savant)
  avgSwingLength    ← playerContact.avgSwingLength (from Savant)
  priorABResults    ← playerContact.priorABResults (from live feed BIP)
  xBA               ← playerContact.xBA (from Savant)
  xSLG              ← playerContact.xSLG (from Savant)
}
```

`lastABContact` (shown on play cards):
```typescript
lastABContact: {
  exitVelo    ← lastAB.exitVelocity ?? playerContact.exitVelocity
  launchAngle ← lastAB.launchAngle ?? playerContact.launchAngle
  batSpeed    ← playerContact.avgBatSpeed  // season average, NOT null
  distance    ← lastAB.distance ?? playerContact.hitDistance
  barrelPct   ← playerContact.barrelPct
  hardHitPct  ← playerContact.hardHitPct
  outcome     ← lastAB.outcome
}
```

---

## 6. Pre-Hydration Flow

When a new game is discovered, `preHydrateNewGame` runs:

```
Phase 1 (parallel):
  ├── syncGameState          ← identifies starting pitcher + lineup
  ├── syncWeather            ← MLB API venue weather
  ├── syncOpenMeteoWeather   ← fallback weather from coordinates
  └── syncPitcherSeasonStats ← starting pitcher ERA/WHIP
```

After Phase 1, regular poll cycles take over every 10 seconds.
The first poll cycle also calls `syncSavantSeasonForLineup` which
enriches all batters with Savant season data.

---

## 7. Engine Recalculation Triggers

The `detectStateChange` function compares previous vs current game state.
Triggers include:

| Trigger | Impact Level | Markets Affected |
|---------|-------------|-----------------|
| `new_ab` | High | All batter markets |
| `ab_completed` | High | All batter markets |
| `inning_change` | High | All markets |
| `pitcher_change` | High | All markets (new pitcher context) |
| `score_change` | High | HRR, total_bases |
| `tto_shift` | Medium | Pitcher markets |
| `pitch_count_threshold` | Medium | Pitcher markets |
| `runner_change` | Low | hits, total_bases, hrr |
| `ball_in_play` | Low | Batter markets |

---

## 8. Common Failure Modes & Protections

| Failure | Protection |
|---------|-----------|
| Savant CSV rate limited (HTTP 429) | Stale cache returned; 4-hour TTL prevents rapid retries |
| MLB Stats API empty splits | Existing cache preserved, only `fetchedAt` refreshed |
| Network timeout on any fetch | Catch block preserves existing cache, refreshes timestamp |
| Server restart wipes all memory | Pre-hydration re-fetches everything; Savant re-enriches on first poll |
| Pinch hitter enters mid-game | `syncSavantSeasonForLineup` patches new players into contactData |
| Player has 0 AB (walks/Ks only) | Still gets contactData entry with Savant season stats via merge |

---

## 9. File Map

| File | Responsibility |
|------|---------------|
| `server/mlb/dataPullService.ts` | All sync functions, cache definitions, data merging |
| `server/mlb/dataSources.ts` | `fetchBaseballSavantData`, Savant CSV parsing, stadium coords |
| `server/mlb/liveGameOrchestrator.ts` | Poll loop, pre-hydration, input building, engine triggering |
| `server/mlb/types.ts` | TypeScript interfaces for all cache/input/output types |
| `server/mlb/edgeCache.ts` | Final signal output cache (6-hour TTL) |
| `server/mlb/normalizeSignal.ts` | Transforms raw engine output to frontend-ready format |

---

## 10. Modification Checklist

Before changing any sync function or cache:

- [ ] Does the function MERGE with existing cache or OVERWRITE?
- [ ] If API returns empty/null, does existing valid data survive?
- [ ] If fetch throws, does existing cached data survive?
- [ ] Does the Savant enrichment path still work for all players?
- [ ] Is `lastABContact` still populated from `playerContact` fields?
- [ ] Are TTLs appropriate (season data = hours, live data = per-poll)?
- [ ] Test: restart server, wait 2+ poll cycles, verify data persists
