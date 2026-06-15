# LiveLocks by PropPulse

Real-time sports betting analytics platform for MLB, NBA, and NCAAB. Generates live signals with confidence tiers, matchup intelligence, and HR radar alerts.

## Quick Start

```bash
npm install
npm run dev
```

The app runs on port 5000 (Express backend + Vite frontend).

---

## Architecture

```
client/src/          React frontend (Vite + Tailwind + shadcn/ui)
  pages/             Page components (dashboard, mlb-live, ncaab-live, etc.)
  components/        UI components organized by feature
    mlb/             MLB-specific components (MlbSignalCard, LiveBoard, etc.)
    signals/         Cross-sport signal components
    dashboard/       Dashboard panels (TopPlays, TrustTrackRecord, etc.)
    ui/              shadcn/ui primitives
  lib/               Data mapping, view models, query client
    mlb/             MLB-specific view models and normalizers

server/              Express backend
  mlb/               MLB engine (core)
    featureEngineering.ts       11 normalized feature scores per matchup
    markets.ts                  Market-specific probability engines (hits, TB, HR, K, etc.)
    projections.ts              Baseline projection with modifier application
    signalScore.ts              0-100 signal scoring (pitch mix, HR timing, pitcher fatigue components)
    hrConversionModel.ts        HR conversion probability with pitch-mix × handedness multiplier
    HRSignalBuilder.ts          HR contact classification and build scoring
    evaluateHRAlert.ts          Three-path HR alert system with negative suppression
    normalizeSignal.ts          Engine output → flat MLBSignal with display fields
    liveGameOrchestrator.ts     Central heartbeat — game discovery, polling, engine triggering
    dataPullService.ts          MLB Stats API + pitcher recent-starts fetching and caching
    dataSources.ts              Baseball Savant, park factors, wind calculations
    onlyHomersService.ts        OnlyHomers.com scraper (HR outcomes, hot hitters, ballparks)
    edgeCache.ts                TTL-aware in-memory cache for engine outputs
    types.ts                    MLBPropInput, MLBPropOutput, MLBQualifiedSignal types
    archetypes.ts               8 batter + 6 pitcher archetype classification
    diagnostics.ts              Engine diagnostic logging
    hrRadarStateMachine.ts      Canonical HR Radar lifecycle state machine (pure transitions)
    hrRadarCanonicalStore.ts    In-memory persistence for HR Radar lifecycle state
    hrRadarSection.ts           Section/outcome helpers for HR Radar API layer
    hrRadarState.ts             HR Radar state helpers and constants
    hrRadarOutcomeStamp.ts      Outcome stamping for HR Radar records
    nearHrContact.ts            Phase 2.5 near-HR contact detector (pure function)
    nonHrSignalState.ts         BUILDING→ACTIVE→COOLING→CLOSED state engine for non-HR markets
    liveEventInterpretation.ts  Live AB contact scoring (contactScore, nearHrScore, momentum)
    integrityFirewall.ts        Signal integrity enforcement layer
    goldmasterGuard.ts          Goldmaster version lock + per-cycle drift snapshot

  nba/               NBA engine
    probabilityEngine.ts    Normal CDF probability with archetype calibration
    archetypes.ts           7 player archetypes
    marketFamily.ts         Signal family grouping and derivative suppression
    directionalBias.ts      Over/Under balance monitoring

  engines/            Sport-isolated engine wrappers
    nba/              NBA engine processor, types, validation
    mlb/              MLB engine processor, types, validation

  services/           Shared services
    nbaStatsService.ts      NBA usage rates and defensive matchups
    minutesProjectionService.ts  Minutes projection sync (RotoWire, Sleeper)

  validation/nba/     NBA engine validation harness (55 constants, 10 fixtures)

  routes.ts           All API routes with auth/tier middleware
  storage.ts          Database interface (IStorage + DatabaseStorage)
  auth.ts             JWT authentication middleware
  stripeService.ts    Stripe subscription management
  index.ts            Server entry point with startup migrations

shared/              Shared between frontend and backend
  schema.ts           Drizzle ORM schema (20 tables) + TypeScript types

docs/                Documentation
  ENGINE_REFERENCE.md  Complete engine function reference
  PRD.md              Product requirements document
```

---

## MLB Engine Pipeline

```
GAME DISCOVERY (5min) → PRE-HYDRATION → LIVE POLLING (10s)
    → FEATURE ENGINEERING (11 scores)
    → MARKET ENGINE (distribution math)
    → QUALIFICATION GATE
    → SIGNAL NORMALIZATION
    → API → UI CARD
```

### Feature Scores (per batter/pitcher matchup)
1. **contactQuality** — Exit velocity, hard hit rate, barrel rate, xBA, xSLG
2. **batSpeedPower** — Bat speed z-scores, power profile
3. **handednessMatchup** — Platoon advantage (L/R splits)
4. **pitchBlendMatchup** — Batter performance vs pitcher's arsenal
5. **hotColdForm** — Rolling 7/15/30-day trends
6. **bvp** — Career Batter vs Pitcher history
7. **parkEnv** — Park factor, temperature, wind, humidity
8. **lineupOpportunity** — Batting order slot, remaining PA, inning
9. **bullpenFactor** — Opposing bullpen ERA, usage, reliever availability
10. **pitcherSuppression** — Current pitcher quality (ERA, WHIP, K/9)
11. **pitcherDeterioration** — Pitch count, velocity drop, fatigue signals

### Supported Markets
- **Batter**: hits, total_bases, home_runs, hrr (H+R+RBI)
- **Pitcher**: pitcher_strikeouts, pitcher_outs, hits_allowed, walks_allowed

### HR Radar
Contact-based HR opportunity detection with:
- **Canonical state machine** (`hrRadarStateMachine.ts`): 9 states — `inactive → watch → build → ready → fire → cashed|missed|model_review|expired`. Terminal states are sticky; illegal transitions are rejected, not thrown.
- **Three alert paths** (PATH_A, PATH_B, PATH_C) with negative suppression vetoes in `evaluateHRAlert.ts`
- **Near-HR contact detector** (`nearHrContact.ts`, Phase 2.5): pure function surfacing `watch|lean` tiers from EV/LA/distance/xBA/barrel data, with `REPEATED_DANGER` pattern detection
- **Signal gap components** added to `signalScore.ts` and `hrConversionModel.ts`:
  - **Gap 1 — Pitch-mix × handedness**: `computePitchMixMatchupScore` (12% weight in HR markets); fastball-heavy = +10%/+4%, breaking-heavy = −8%, offspeed-heavy = −5%
  - **Gap 2 — HR timing**: `computeHrTimingComponent` (8% weight); scores overdue batters (≥3× expected AB/HR rate) at 90, recently-hit batters at 35
  - **Gap 3 — Pitcher entry fatigue**: `computePitcherEntryFatigueScore` (5–8% weight) using last 3 starts (pitch count, days rest, ERA); max +30%/−10% conversion multiplier

### Intelligence Layers
- **BvP History**: Career matchup stats flowing through to signal cards
- **Arsenal Matchups**: Bidirectional pitch-type ratings (batter favor / pitcher favor)
- **OnlyHomers**: Hot hitter boosts, verified HR outcomes, ballpark factors
- **Signal state labels**: `LiveFeed.tsx` and `MlbBoxScore.tsx` display conviction states (FIRE, READY, BUILD, WATCH) and live counts for monitored games and active batter profiles

---

## NBA Engine

Normal CDF probability model with 7 player archetypes, fragility scoring, calibration shrinkage, and safety ceilings. Market family grouping prevents derivative signal spam. Directional bias tracking detects Over/Under skew.

---

## NCAAB Engine

Normal CDF with deterministic edge rules. Supports spreads, totals, and team totals for full game, 1H, and 2H. Dynamic multiplier scaling with game progress.

---

## Data Sources

| Source | Data | Frequency |
|:---|:---|:---|
| MLB Stats API | Game state, box scores, play-by-play, BvP, pitcher stats | 10s |
| ESPN API | Game discovery, roster sync, NBA/NCAAB data | 5min |
| The Odds API | Player prop odds (11 sportsbooks) | Per request |
| Baseball Savant | xBA, xSLG, bat speed, barrel rate | Per game |
| OnlyHomers.com | HR outcomes, hot hitters, ballpark factors | Hourly |
| Open-Meteo | Weather forecasts | 10min |

---

## Database

20 PostgreSQL tables via Drizzle ORM:

- **Users & System**: users, stripe_events, app_settings, feedback, signal_interactions
- **NBA/NCAAB**: players, team_defense, parlay_picks, halftime_play_alerts, play_results, sent_alerts
- **MLB**: contact_events, game_player_stats, hr_radar_alerts, hr_radar_analytics, hr_outcomes, hr_hot_hitters, hr_ballpark_factors
- **Universal**: persisted_plays (60+ columns), persisted_alerts

---

## Subscription Tiers

| Tier | Price | Access |
|:---|:---|:---|
| Free | $0 | 3 NBA plays/day, 2 MLB games/day preview |
| Pro | $40/mo | NBA + NCAAB, expanded MLB |
| All Sports | $65/mo | Full access all sports |

3-day free trial on all paid plans. Stripe handles billing and webhooks.

---

## Key Commands

```bash
npm run dev              # Start dev server (Express + Vite on port 5000)
npm run db:push          # Sync Drizzle schema to database
npx tsx server/validation/nba/run.ts  # Run NBA validation harness
```

---

## Environment Variables

| Variable | Purpose |
|:---|:---|
| DATABASE_URL | PostgreSQL connection |
| SESSION_SECRET | JWT signing |
| ADMIN_EMAIL | Admin account bootstrap |
| ODDS_API_KEY / ODDS_API_KEY_2 | The Odds API (auto-rotation) |
| SGO_API_KEY | Sports Game Odds (1H lines, team totals) |
| STRIPE_SECRET_KEY | Stripe billing |
| VITE_STRIPE_PUBLISHABLE_KEY | Stripe frontend |
| TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER | SMS alerts |
| VAPID_PUBLIC_KEY/PRIVATE_KEY | Web push |
| RESEND_API_KEY | Transactional email |

---

## Documentation

- **[ENGINE_REFERENCE.md](docs/ENGINE_REFERENCE.md)** — Complete function reference for all engines
- **[PRD.md](docs/PRD.md)** — Full product requirements document
