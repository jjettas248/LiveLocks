# LiveLocks by PropPulse — NBA/NCAAB Live Lines

## Overview
LiveLocks is a full-stack Progressive Web Application (PWA) designed for betting analytics in NBA and NCAAB. It provides real-time probabilities for player prop bets, analyzes NCAAB live spread/total/team-total probabilities, and enables users to construct correlation-adjusted parlays. The platform aims to enhance sports bettors' decision-making with data-driven insights and sophisticated analytical tools by integrating live game data and offering subscription-based access, notifications, and an administrative panel.

## User Preferences
I prefer clear and concise explanations. When implementing new features or making significant changes, please propose the high-level plan first and wait for my approval before proceeding with detailed implementation. For UI/UX, I prefer modern, clean designs with intuitive navigation. I am open to iterative development and feedback loops.

## System Architecture

### Frontend
- **Frameworks**: React with Vite, Tailwind CSS, and `shadcn/ui`.
- **Data Fetching**: TanStack Query.
- **Routing**: `wouter`.
- **UI/UX**: Features a top tab bar for sports with sub-tabs for specific analyses. Subscription tiers control feature access. Includes book filtering, probability gauges, EV verdicts, CLV indicators, and H2H matchup history. Daily slate reset system. Mobile-optimized components like a Parlay Slip bottom sheet and pull-to-refresh. PWA updates via service worker with `skipWaiting` and network-first strategy. Engine-calibrated probabilities are displayed directly from the server.

### Backend
- **Framework**: Express.js with TypeScript and `tsx`.
- **Database**: PostgreSQL with Drizzle ORM.
- **Shared Components**: `shared/schema.ts` and `shared/routes.ts` for type safety.
- **Authentication**: JWT-based authentication with role-based access control tied to subscription tiers (Free, Pro, All Sports).
- **Notifications**: Twilio for SMS alerts, Resend for transactional emails.
- **NBA Probability Engine (v2)**: Uses distribution-based probability with normal CDF, variance models, and archetype-based calibration. Implements market family grouping, derivative suppression, and directional bias tracking. Includes detailed diagnostics for each play.
- **NCAAB Engine**: Provides projections, probabilities (normal CDF model), and pick directions with deterministic edge rules. Features a diagnostics module and a `qualifiedEdge`/`fallback` architecture for market surfacing, applying weighted scoring for Top Plays and color-coded confidence tiers (ELITE, STRONG, LEAN). Halftime cards show live 2H context. **Dynamic Engine Contract**: `/api/ncaab/live` prepares full canonical payloads with `selectedMarket` (best market auto-selected) and `periodMarkets` (pre-computed selectedMarket objects for full/h1/h2 tabs). UI performs zero calculations — all coverProbability, edge, confidenceLabel, engineProbability, bookProbability, signalTag, and signalDirection are server-resolved. Big ring = selected market cover confidence; small rings = full game total over/under probabilities. Cards follow strict hierarchy: header → big ring → small rings → source pill → EV card → CLV card → market tabs.
- **MLB Prop Engine**: Processes various MLB player prop markets (Hits, Total Bases, Batter K, Pitcher K, Hits Allowed, HR) via a modular pipeline. Features a form indicator system, HR qualifying factors, scout-report translation, and a `SignalScore` system for confidence tiers (ELITE, STRONG, SOLID, WATCHLIST, NO_SIGNAL) based on a probability-first approach. Signals are ranked and styled by tier on the frontend.
- **HR Signal Builder**: `server/mlb/HRSignalBuilder.ts` augments HR signals with a 0-10 build score computed from in-game contact quality (avg/max EV, launch angle, barrels, hard hits, deep flyouts), pitcher fatigue, park/wind, and platoon advantage. Produces `hrBuildScore`, `hrIntensity` ("weak"|"watch"|"strong"|"imminent"), and an edge boost (0-4%) applied to the HR market edge. HR signals gain intensity-based visual treatment (border glow, color escalation, pulse animation for "imminent"). Contact events are persisted to `contact_events` table for learning.
- **MLB Signal Pipeline**: Employs a clean ENGINE → NORMALIZER → API → UI CARD pipeline with a single source of truth (`MLBSignal` interface). `normalizeMLBSignal()` transforms engine output into a flat `MLBSignal` with sided probability selection, market alias normalization, current stat computation, `alreadyHit` detection, pitch mix fallback, smart tag generation, and primary reason generation. Includes a **signal→projection link** that adjusts pitcher market projections based on active pitcher signals (DOMINANT +8%, K_STREAK +6%, COMMAND_LOCKED +4%, FATIGUE_RISK -5%, VELOCITY_DROP -4%, HARD_CONTACT -6%).
- **Top Live Opportunities**: Ranking system using `liveScore = (signalScore/100) × clamp(edge/100,0,1) × (opportunityScore/100)` with event-driven boost component. Frontend displays top-5 by liveScore with ELITE/STRONG/SOLID/WATCH tiers. SpikeAlertBanner triggers at liveScore ≥ 0.10. Pitcher signal badges (DOM/K RUN/CMD/VELO↓/TIRED/HARD HIT) shown on signal cards. New DB columns: signal_score, opportunity_score, live_score, event_boost in persisted_plays.
- **MLB HR Market Fallback**: `resolveBookLine()` in `liveGameOrchestrator.ts` falls back to a line of 0.5 for `home_runs` when no real line is available, aligning with the industry standard for HR O/U.
- **Simplified MLB Card UX**: `MlbSignalCard.tsx` redesigned for quick decision-making, offering a collapsed view with key signal info and an expanded view for detailed metrics, contact quality, driver breakdown, pitcher arsenal, BvP history, and risk flags. Smart tags and primary reasons are server-computed.
- **MLB Intelligence Layer**: Implements an archetype-driven intelligence pipeline with 8 batter and 6 pitcher archetypes, including variance multipliers, fragility thresholds, thesis generation, and market family suppression with penalty factors for derivatives. Features directional bias tracking with drift detection and archetype-specific safety ceilings.
- **MLB Probability Engine (v2.1)**: Pure probability computation module with no access to book lines. Computes model probability from projection, threshold, and market variance using market-specific distribution methods (normal CDF, negative binomial, binomial). Calibration and safety ceiling application are integrated.
- **MLB Distribution-First Engine Upgrade**: Core MLB markets (hits, total_bases, pitcher_strikeouts, home_runs) rewritten from heuristic math to market-specific outcome-distribution math. New modules for event rates, PA/BF distributions, and outcome distributions. Incorporates calibration shrinkage, market probability ceilings, and edge vs book implied calculations. Includes trust gating for projection quality.
- **MLB Phase 2 Engine Rebuild**: Features a spec-compliant feature layer with 11 normalized scores (e.g., contactQuality, batSpeedPower, handednessMatchup). Market engines in `markets.ts` use weighted formulas. A badge system populates canonical `badges[]`/`riskFlags[]`. An integrity firewall enforces probability ceilings and qualification floors. Confidence score uses a 5-component weighted formula. Event-driven recalculation triggers for high-impact game events.
- **Real-Time Data Pipeline (AB-to-AB)**: MLB orchestrator polls game state every 10s, with event-driven engine recalculation on every at-bat. High-impact triggers (`new_ab`, `ab_completed`, `out_recorded`, `score_change`, `inning_change`, `pitcher_change`, `tto_shift`, `lineup_substitution`) use 5s dedup for near-instant re-evaluation. `GameStateCache` tracks `homeScore`, `awayScore`, `totalPlays` for AB completion detection. `PlayerContactData` stores both max EV (`exitVelocity`) and latest AB's EV (`latestExitVelocity`/`latestLaunchAngle`). `completedAB` per batter uses actual box score AB count. Server cache TTLs: live games 15s, boxscore stats 15s, signals 30s. Signal staleness gate: 10min (FEED_FRESHNESS_MS). Frontend polls: games list 15s, edge feed 20s, HR radar 20s, boxscore 15s, signal counts 20s. Live pulse indicator shows data freshness on the game strip and boxscore headers.
- **Signal Pipeline Resilience**: Cache preservation prevents empty engine runs (when no markets are evaluated due to data unavailability) from overwriting valid cached signals, bounded by a 10-minute max age. Heartbeat mechanism refreshes `updatedAt` on cache entries with either qualified or watch signals when no state change is detected. Edge cache `entries()` filters TTL-expired entries consistently with `get()`.
- **Early Signal Mode**: Removed hard `playerAB < 1` gate and `pitchCount < 10` gate that blocked ALL signal generation in early innings. Engine now evaluates every batter and pitcher from first pitch. Pre-AB signals are tagged as `isEarlySignal: true` with `WATCHLIST` confidence tier and "Pre-Game Edge" smart tag. Once a batter completes their first AB, signals upgrade to full qualification. This ensures the UI always has content from game start.
- **HR Engine v2 (Conversion-Based Alert Model)**: Complete rebuild of `HRSignalBuilder.ts` and `evaluateHRAlert.ts` targeting 20-25% alert hit rate. **Event Classification**: Every batted ball classified as noiseContact/powerContact/hrShapedContact/missedHrContact/eliteHrContact using EV/LA/distance thresholds (e.g., hrShaped: EV≥98+LA 20-38°+dist≥360, eliteHr: EV≥102+LA 23-34°+dist≥390). **Three Alert Paths**: PATH_A (2+ HR-shaped events, qualified EV mean ≥99, max dist ≥375, remaining PA ≥1.3), PATH_B (1 missed/elite HR + pitcher fatigue or env favorable), PATH_C (late-game inning 5+ with HR-shaped contact + favorable pitcher). **Hard Caps**: No official alert from single barrel/hardHit/deepFly/103EV alone. No alert when remaining PA <1.0 without elite evidence. **Negative Suppression**: Veto-based system checks remaining PA, repeat confirmation, LA consistency, headwind, same-side matchup, cold temperature. Hard vetoes block alerts entirely; soft vetoes reduce confidence. **Alert Tiers**: officialAlert/prepare/watch with full diagnostics (alertPath, positiveFactors, suppressionFlags, pitcherFatigueState, environmentContext, contactClasses). All context (remainingPA, pitchCount, timesThrough, parkFactor, wind, temperature, handedness) passed from orchestrator. 10-minute per-player cooldown preserved.
- **HR Radar System v2 (Canonical Model)**: Dedicated `hr_radar_alerts` table with unique constraint on (session_date, game_id, player_id) for hard dedup — one outcome per player/game/session. `hr_radar_analytics` table for durable performance history. Storage CRUD: `createOrUpdateHrRadarAlert` (upsert with score tracking + increase detection), `resolveHrRadarAlertAsHit`, `resolveHrRadarAlertAsMiss`, `reconcileHrRadarAlertsForGame` (bulk hit/miss resolution → dedup → archive), `collapseDuplicateHrRadarOutcomes`, `archiveDailyHrRadarOutcomesToAnalytics`. API routes: `GET /api/mlb/hr-radar-board` (today's board), `GET /api/mlb/hr-radar-analyze/:playerId/:gameId` (AB-by-AB analyze modal with full contact data), `GET /api/admin/hr-radar-analytics` (admin analytics with filters). Client: `HrRadarCardUi` extended with `detectedLabel`, `scoreIncreased`, `scoreIncreaseLabel`, `peakScore`. `HrRadarAnalyzeViewModel` type for analyze modal. Analyze button opens full batter detail modal with score trajectory, AB log with BRL/HH badges, trigger tags, and engine factors. Admin analytics surface in analytics-tab.tsx with summary stats, filtering, and graded history table.
- **MLB UI Architecture (NBA-mirrored rebuild)**: Dashboard with sub-tabs [Games | Live Feed | HR Radar]. **Games tab** features a horizontal game chip strip and a two-panel layout for selected games, displaying game context and active signals via `MlbSignalCard`. **Live Feed tab** shows `TopPlays` and `LiveBoard` (tier-grouped). **HR Radar tab** focuses on HR edges and activity. **Unified `MlbSignalCard`** is used across all views, collapsing by default and expanding to show detailed info. Includes a signal state machine and floating bet slip.
- **MLB Canonical Normalizers (`mlbNormalizers.ts`)**: Centralized display helpers for MLB UI. `formatMlbDisplayInning(game)` produces clean ▲/▼ inning text, `formatMlbDisplayStatus(game)` sanitizes all status strings (live/final/pregame/delayed/suspended), `normalizeMlbGameChip(game)` produces a canonical `MlbGameChipViewModel` consumed directly by GameChipStrip (no manual status branching). `deriveMlbQuickViewColorTier(signals, playerId)` maps signals to green/yellow/blue/neutral row accents (75%+/65%+/55%+ thresholds). `deriveBestPlay(signals, playerId)` returns the best play info with market, side, probability, and confidence tier. Used by MlbBoxScore for color-coded scanning rows. No NBA logic — MLB-only probability thresholds.
- **MLB Grading (Phase 5)**: End-to-end MLB play grading using MLB Stats API boxscores, resolving ESPN event IDs to MLB gamePk. Maps 14 markets to boxscore fields. Grading cron runs every 3 minutes, with admin endpoints for manual trigger and grading summaries.
- **Roster Sync**: API endpoint for synchronizing ESPN rosters and team abbreviations, handling cross-date listings.

### Decision Engine Dashboard
- **Live Edge Feed**: Collapsible button for cross-sport edge cards.
- **Trust Track Record Panel**: Public-facing 7-day win rate and ROI.
- **User Status Rail**: Displays user's tier, plays used, live signal counts, and 7-day win rate.
- **Live Update Toast**: Notifies users of new ELITE edges across sports.
- **Shared Signal Components**: Reusable UI components for displaying signals and confidence across all sports.

### Admin Panel
- Manages users, subscription tiers, play counts, feedback, and daily slate reset times.

## External Dependencies

- **ESPN**: Live game data, scores, player statistics.
- **The Odds API**: Spread/total book lines, American odds. Supports multi-key rotation (`ODDS_API_KEY`, `ODDS_API_KEY_2`) — when one key's quota is exhausted, the system automatically rotates to the next available key and retries.
- **Sports Game Odds (SGO)**: 1H lines, team total lines.
- **Stripe**: Payment gateway for subscriptions.
- **Twilio**: SMS notifications.
- **Resend**: Transactional email service.
- **PostgreSQL**: Application data storage.

## Engine Isolation Architecture (v1.0)

### Overview
NBA and MLB engines are fully isolated into separate systems under `server/engines/`. Each sport has its own validation rules, confidence tiers, fallback modes, and diagnostics — zero shared calculation logic between sports.

### Structure
- `server/engines/nba/` — NBA engine wrapper (regression-based, edge threshold, low-frequency)
  - `index.ts` — `processNBAEngine()` entry point, maps candidates → NBAPlay[], applies strict/fallback filtering
  - `types.ts` — NBAPlay, NBAEngineOutput, NBAEngineDiagnostics, NBAValidationRules with strict/fallback constants
  - `validation.ts` — NBA-specific signal validation (edge minimum, probability bounds, projection alignment)
- `server/engines/mlb/` — MLB engine wrapper (contact-based, event-driven, high-frequency)
  - `index.ts` — `processMLBEngine()` entry point, maps candidates → MLBPlay[], confidence tiering instead of hard edge filter
  - `types.ts` — MLBPlay, MLBEngineOutput, MLBEngineDiagnostics, MLBContactProfile, MLBValidationRules
  - `validation.ts` — MLB-specific signal validation (confidence tier minimum, no regression)
- `docs/agents/nba-agent.md` — Locked NBA engine agent specification
- `docs/agents/mlb-agent.md` — Locked MLB engine agent specification

### Key Contracts
- NBA output: `{ plays, engine: "NBA", mode: "strict"|"fallback", confidence: "low"|"medium"|"high", diagnostics }`
- MLB output: `{ plays, engine: "MLB", mode: "strict"|"fallback", confidence: "developing"|"strong"|"elite", contactProfile, diagnostics }`

### Orchestration
- `routes.ts` imports `processNBAEngine` and `processMLBEngine` directly
- NBA live-signals path uses NBA engine wrapper (no shared `filterValidSignals`/`filterValidEngineOutputs`)
- MLB live-signals path uses MLB engine wrapper for diagnostics and engine tagging
- NCAAB uses shared services (not yet isolated); standalone `/ncaab` page at `client/src/pages/ncaab-live.tsx` with `/api/ncaab/live` endpoint
- Debug endpoint: `GET /api/debug/engine-isolation` shows isolation status and cross-contamination check

## NBA Engine Validation Harness

### Overview
A permanent validation framework that encodes `NBA_Model_Logic.md` into executable assertions, automatically detecting any drift in implementation, calibration, filtering, or output shape.

### Files
- `server/validation/nba/harness.ts` — Core harness with constant validation, archetype classification tests, fixture scenarios, calibration stability checks, drift reporting
- `server/validation/nba/fixtures.ts` — 10 deterministic test scenarios covering all 7 archetypes, combo props, under-side, halftime H1→H2 transitions
- `server/validation/nba/run.ts` — CLI runner (exit code 0 = pass, 1 = fail)

### What It Validates
- All 55 engine constants (variance multipliers, fragility multipliers, correlations, combo extras, safety ceilings) match documented values
- 8 archetype classification test cases
- 10 fixture scenarios testing directional integrity, probability bounds, output contracts, fragility reasons, ceiling enforcement
- Calibration stability (average confidence range, over/under balance)

### Running
- **CLI**: `npx tsx server/validation/nba/run.ts`
- **Admin endpoint**: `GET /api/debug/nba/validate` (requires admin auth)

### Drift Types Detected
ARCHETYPE_DRIFT, BLENDED_RATE_DRIFT, CALIBRATION_DRIFT, FRAGILITY_DRIFT, SAFETY_CEILING_DRIFT, DIRECTIONAL_INTEGRITY_FAILURE, PROBABILITY_BOUNDS_FAILURE, OUTPUT_CONTRACT_FAILURE, COVARIANCE_DRIFT, CONSTANT_DRIFT