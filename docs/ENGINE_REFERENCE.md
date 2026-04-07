# LiveLocks Engine & Agent Function Reference

## Table of Contents
- [MLB Engine Functions](#mlb-engine-functions)
- [MLB Services & Orchestration](#mlb-services--orchestration)
- [NBA Engine Functions](#nba-engine-functions)
- [NBA Services](#nba-services)
- [NCAAB Engine](#ncaab-engine)
- [Shared Infrastructure](#shared-infrastructure)

---

## MLB Engine Functions

### Feature Engineering (`server/mlb/featureEngineering.ts`)

| Function | Purpose |
|:---|:---|
| `computeFullFeatureLayer(input)` | Master aggregator — computes all 11 normalized feature scores into a single `FeatureLayer` object consumed by market engines |
| `computeSpecContactQuality(input)` | Scores batter contact quality (0-1) from exit velocity, hard hit rate, barrel rate, xBA, xSLG |
| `computeBatSpeedEngine(input)` | Evaluates bat speed and power profile using barrel rate proxies and fast-swing metrics |
| `computeSpecHandednessMatchup(input)` | Calculates platoon advantage (L vs R, R vs L, same-side penalty) |
| `computeSpecPitchBlendMatchup(input, mode)` | Rates batter performance against each pitch type in the pitcher's arsenal. Modes: "damage" (for hits/TB/HR) and "whiff" (for strikeouts) |
| `computeSpecHotColdForm(input)` | Determines if batter is hot/cold based on rolling 7/15/30-day averages and recent at-bat results |
| `computeSpecBvP(input)` | Batter vs Pitcher history score — uses career matchup batting average with sample-size dampening (10-20 AB threshold) |
| `computeSpecLineupOpportunity(input)` | Scores remaining opportunity based on batting order slot, remaining plate appearances, inning, and bullpen path |
| `computeSpecBullpenFactor(input)` | Evaluates opposing bullpen strength from ERA, recent usage, and top reliever availability |
| `computeSpecParkEnv(input)` | Park and environment score combining park factor, temperature, wind speed/direction, humidity |
| `computeSpecPitcherSuppression(input)` | Rates how much the current pitcher suppresses offense (ERA, WHIP, K/9, BB/9) |
| `computeSpecPitcherDeterioration(input)` | Detects pitcher fatigue from pitch count, times through order, velocity drop, and collapse signals |
| `classifyContactQuality(metrics)` | Categorizes a batted ball as "ELITE", "HARD", "MEDIUM", or "SOFT" |
| `computeLiveContactQualityScore(metrics)` | Numerical score (-0.05 to 0.35) reflecting today's contact quality |
| `computeFormScore(input)` | Weighted form score from rolling stats and recent contact |
| `classifyForm(input)` | Labels form as "HOT", "WARM", "NEUTRAL", "COLD", or "SLUMPING" |
| `applyTwoABRule(input)` | Gates live form boosts until batter has enough plate appearances (or explosive early contact) |
| `computeHRQualifyingFactors(input)` | Checks strict HR signal requirements (EV, barrel rate, power indicators) |
| `meetsHRQualificationGate(input)` | Boolean gate for HR signal eligibility |
| `computeBatSpeedEngine(input)` | Bat speed/power estimation from barrel rate proxies |
| `computePitcherAnalysisScores(input)` | Analyzes pitcher Stuff, Command, and Swing-and-Miss rates |
| `generatePitcherSignals(input, analysis)` | Produces pitcher tags: DOMINANT, K_STREAK, COMMAND_LOCKED, FATIGUE_RISK, VELOCITY_DROP, HARD_CONTACT |
| `computeBadges(input)` | Generates UI badges (Hard Hit Streak, Pitcher Fatigue, etc.) |

### Market Engines (`server/mlb/markets.ts`)

| Function | Purpose |
|:---|:---|
| `calculateMLBPropEdge(input)` | Router — directs input to the correct market-specific engine |
| `calculateHitsEdge(input)` | Hits market engine — distribution-based probability from contact quality, lineup opportunity, pitcher vulnerability |
| `calculateTBEdge(input)` | Total Bases market engine — factors power profile and extra-base hit probability |
| `calculateHREdge(input)` | Home Runs market engine — uses binomial distribution with HR-specific qualifying factors |
| `calculateHRREdge(input)` | Hits + Runs + RBIs market engine — composite stat projection |
| `calculatePitcherKEdge(input)` | Pitcher Strikeouts engine — K/9, swing-and-miss rate, opponent contact quality |
| `calculatePitcherOutsEdge(input)` | Pitcher Outs (recording outs) engine |
| `calculateHitsAllowedEdge(input)` | Hits Allowed engine — pitcher vulnerability to contact |
| `calculateWalksAllowedEdge(input)` | Walks Allowed engine — pitcher command analysis |
| `calculateBatterStrikeoutsEdge(input)` | Batter Strikeouts engine (no bookmaker data available — not active) |
| `hasRealOdds(market)` | Validates that real sportsbook odds exist (no synthetic defaults allowed) |
| `canShowSignal(data)` | Full hydration check — line, odds, projection, and probability must all be valid |

### Projection Engine (`server/mlb/projections.ts`)

| Function | Purpose |
|:---|:---|
| `projectBaseValue(input)` | Calculates base projection from season average extrapolated over remaining PA, then applies all feature-engineered modifiers (weather, pitcher, form, BvP, park) |

### Signal Scoring (`server/mlb/signalScore.ts`)

| Function | Purpose |
|:---|:---|
| `computeSignalScore(input, output)` | Generates 0-100 signal strength score from probability, projection gap, live context, matchup quality, form, and opportunity |
| `deriveSignalTags(input, output, score)` | Assigns descriptive tags: HOT OVER, HR WATCH, ATTACKABLE PITCHER, etc. |
| `deriveFeedTags(input, output, score)` | Categorizes for feed display (inning context, market type) |
| `deriveGameCardTags(signals)` | Game-level tags (LIVE SIGNALS, HR ACTIVITY, etc.) |
| `derivePitcherSignals(input, output)` | Technical pitcher assessment tags |
| `isPlayerGlowEligible(score, tags)` | Determines if player qualifies for UI glow effect |

### HR Signal Builder (`server/mlb/HRSignalBuilder.ts`)

| Function | Purpose |
|:---|:---|
| `buildHRSignal(input)` | Master HR analysis — processes all in-game contact to produce intensity score (weak/watch/strong/imminent) and 0-10 build score |
| `classifyContactEvent(ab)` | Classifies each at-bat: noiseContact, powerContact, hrShapedContact, missedHrContact, eliteHrContact |

### HR Alert Evaluation (`server/mlb/evaluateHRAlert.ts`)

| Function | Purpose |
|:---|:---|
| `evaluateHRAlert(data)` | Three-path alert system: PATH_A (2+ HR-shaped events), PATH_B (missed HR + pitcher fatigue), PATH_C (late-game favorable context) |
| Negative suppression | Veto system checks remaining PA, headwind, same-side matchup, cold temperature |

### Signal Normalization (`server/mlb/normalizeSignal.ts`)

| Function | Purpose |
|:---|:---|
| `normalizeMLBSignal(qs, raw, ctx)` | Transforms engine output into flat `MLBSignal` with sided probability, market alias normalization, pitch matchup ratings (bidirectional batter-favor/pitcher-favor), smart tags, and primary reason |

---

## MLB Services & Orchestration

### Live Game Orchestrator (`server/mlb/liveGameOrchestrator.ts`)

| Component | Purpose |
|:---|:---|
| `LiveGameOrchestrator` class | Central heartbeat — discovers games, polls state every 10s, triggers engine on state changes |
| `start()` | Initializes discovery (5min), state polling (10s), weather (10min), OnlyHomers scrape (hourly) |
| `pollGames()` | Discovers today's MLB games, registers new ones, snapshots finished ones |
| `pollGame(gameId)` | Orchestrates data sync → engine trigger → signal qualification for a single game |
| `preHydrateNewGame(game)` | Pre-fetches pitcher stats, weather, and lineup for newly discovered games |
| `triggerEngine(gameId, status, triggers)` | Runs all market engines for all batters and pitchers in a game, producing qualified signals |
| `qualifySignal(gameId, input, output)` | Gates signals through probability floor, edge validation, projection consistency, and HR UNDER suppression |
| `buildWatchSignal(gameId, input, output)` | Creates watchlist-tier signals for plays that don't meet full qualification |
| `resolveBookLine(player, market)` | Deterministic line selection from live odds, prior cache, or fallback |
| `refreshOnlyHomersCache()` | Updates in-memory hot hitter and ballpark factor maps from OnlyHomers data |
| `getOnlyHomersEnrichment(playerName)` | Returns hot hitter status and HR count for a specific batter |
| `checkAndGradeHR(...)` | Detects HR events during polling and resolves associated radar alerts |

### Data Pull Service (`server/mlb/dataPullService.ts`)

| Function | Purpose |
|:---|:---|
| `syncGameState(statsPk, cacheKey)` | Fetches inning, score, runners, lineup from MLB Stats API |
| `syncGameBoxScore(statsPk, cacheKey)` | Pulls live hitting/pitching stats with Tank01 API fallback |
| `syncContactData(statsPk, cacheKey)` | Extracts Statcast hit data (EV, LA, distance) from play-by-play events |
| `syncPitcherContext(statsPk, cacheKey)` | Calculates real-time pitch mix and velocity trends |
| `syncWeather(statsPk, gameId)` | Fetches venue-reported weather conditions |
| `syncOpenMeteoWeather(gameId, venueName)` | High-precision hourly weather forecasts via Open-Meteo |
| `syncPitcherSeasonStats(playerId)` | Fetches ERA, WHIP, K/9, BB/9 for current season |
| `syncBatterRollingStats(playerId)` | Calculates 7, 15, and 30-day rolling performance splits |
| `syncBvPMatchup(batterId, pitcherId)` | Fetches career Batter vs Pitcher matchup history |

### Data Sources (`server/mlb/dataSources.ts`)

| Function | Purpose |
|:---|:---|
| `getMarketParkFactor(venueName, market)` | Returns market-specific park factor for a ballpark |
| `fetchBaseballSavantData(mlbPlayerId, gameId)` | Scrapes Statcast CSVs for advanced metrics (xBA, xSLG, bat speed) |
| `getStadiumCoords(venueName)` | Lat/long and field orientation lookup for wind calculations |
| `windDirectionRelativeToField(windDegrees, fieldOrientation)` | Calculates wind direction relative to home plate (in/out/cross) |

### OnlyHomers Service (`server/mlb/onlyHomersService.ts`)

| Function | Purpose |
|:---|:---|
| `scrapeOnlyHomersDailyHRs()` | Scrapes daily HR outcomes with full Statcast data (EV, LA, distance, pitch type, pitcher, ballpark) |
| `scrapeOnlyHomersHotHitters()` | Scrapes hot hitter lists (7/14/30-day HR frequency) |
| `scrapeOnlyHomersBallparks()` | Scrapes ballpark HR counts for park factor calibration |
| `runFullOnlyHomersScrape()` | Orchestrator — runs all three scrapes in parallel |
| `getBatterVsPitcherHrHistory(batter, pitcher)` | Queries DB for specific BvP HR matchup history |
| `getLiveBallparkFactors()` | Returns current season HR counts per stadium |

### Edge Cache (`server/mlb/edgeCache.ts`)

| Function | Purpose |
|:---|:---|
| `edgeCacheGet(key)` | Retrieves cached engine output (6-hour TTL) |
| `edgeCacheSet(key, entry)` | Stores results, enforces 50-game cap |
| `cleanupExpiredEntries()` | Removes stale entries and finished games |

---

## NBA Engine Functions

### Probability Engine (`server/nba/probabilityEngine.ts`)

| Function | Purpose |
|:---|:---|
| `computeProbability(input, options)` | Main entry point — calculates probabilities using Normal CDF for single stats and combo markets |
| `computeSingleStatMeanAndVariance(stat, input)` | Expected mean and variance for a single stat with archetype multipliers |
| `computeComboMeanAndVariance(market, input)` | Mean/variance for combo markets (PTS+REB+AST etc.) with covariance estimation |
| `computeFragilityScore(inputs)` | Evaluates minutes variance, lineup instability, blowout risk, late-season chaos |
| `calibrate(pSide, ctx)` | Shrinkage factors (0.88 single, 0.78 combo) to prevent overconfidence |
| `getSafetyCeiling(archetype, isCombo)` | Maximum allowed probability based on player archetype |

### Engine Processor (`server/engines/nba/index.ts`)

| Function | Purpose |
|:---|:---|
| `processNBAEngine(candidates)` | Orchestrates signal generation — maps candidates to plays, applies strict/fallback filtering |
| `mapCandidateToPlay(c, idx)` | Transforms raw candidates into structured signals with confidence levels |

### Archetypes (`server/nba/archetypes.ts`)

| Function | Purpose |
|:---|:---|
| `classifyArchetype(input)` | Categorizes players into 7 archetypes: stable_star, volatile_starter, bench_microwave, minutes_dependent, etc. |

### Market Families (`server/nba/marketFamily.ts`)

| Function | Purpose |
|:---|:---|
| `groupIntoFamilies(signals)` | Groups related markets (PTS OVER + PRA OVER) into families |
| `applyFamilySuppression(families)` | Selects flagship per family, suppresses derivatives to prevent signal spam |

### Directional Bias (`server/nba/directionalBias.ts`)

| Function | Purpose |
|:---|:---|
| `isUnderBiasCorrectionActive()` | Monitors Over/Under balance and applies corrective scaling if skewed |

---

## NBA Services

### Stats Service (`server/services/nbaStatsService.ts`)

| Function | Purpose |
|:---|:---|
| `getPlayerUsage(playerName, playerId)` | Fetches real-time usage rates and on/off differential |
| `getTeamDefenseMatchup(teamAbbr)` | Fetches defensive rating and pace-allowed stats |
| `computeUsageAdjustment(usage)` | Calculates projection multiplier (0.8x-1.25x) from usage data |

### Minutes Projection (`server/services/minutesProjectionService.ts`)

| Function | Purpose |
|:---|:---|
| `syncMinutesProjections()` | Synchronizes projected minutes from RotoWire API, Sleeper API, and web scraping |

### Validation Harness (`server/validation/nba/`)

| Component | Purpose |
|:---|:---|
| `harness.ts` | Core validation — tests 55 engine constants, 8 archetype cases, 10 fixture scenarios |
| `fixtures.ts` | 10 deterministic test scenarios covering all archetypes and market types |
| `run.ts` | CLI runner (`npx tsx server/validation/nba/run.ts`) |

---

## NCAAB Engine

The NCAAB engine provides projections, probabilities (normal CDF model), and pick directions with deterministic edge rules. Features a diagnostics module and a `qualifiedEdge`/`fallback` architecture for market surfacing, applying weighted scoring for Top Plays and color-coded confidence tiers (ELITE, STRONG, LEAN).

---

## Shared Infrastructure

### Storage Interface (`server/storage.ts`)

| Method | Purpose |
|:---|:---|
| `calculateProbability(data)` | Core probability computation for NBA/NCAAB |
| `recordPlay(play)` | Persists generated signals to `persisted_plays` |
| `settlePlay(id, result)` | Updates signal with final result (Win/Loss/Push) |
| `tryConsumePlayToday(userId)` | Free-tier play credit system |
| `getAnalyticsSummary()` | Win rate and model performance analytics |
| `createOrUpdateHrRadarAlert(alert)` | Upserts HR radar alerts with dedup |
| `resolveHrRadarAlertAsHit/Miss(id)` | Resolves HR alert outcomes |
| `reconcileHrRadarAlertsForGame(gameId)` | Bulk hit/miss resolution at game end |

### Signal Pipeline

```
ENGINE → NORMALIZER → QUALIFIER → API → UI CARD
```

1. **Engine**: Market-specific calculation produces raw probability, projection, edge
2. **Normalizer**: Flattens into canonical `MLBSignal`/`NBAPlay` with display fields
3. **Qualifier**: Gates through probability floors, edge validation, hydration checks
4. **API**: Serves qualified + watchlist signals to frontend
5. **UI Card**: Renders with confidence tier, badges, arsenal matchups, BvP history
