# LiveLocks by PropPulse — NBA/NCAAB Live Lines

## Overview
LiveLocks is a full-stack Progressive Web Application (PWA) designed for betting analytics in NBA and NCAAB. It offers real-time probabilities for player prop bets at halftime, analyzes NCAAB live spread/total/team-total probabilities, and enables users to construct correlation-adjusted parlays. The platform integrates live game data from ESPN, The Odds API, and Sports Game Odds (SGO). Key features include Stripe-based subscriptions, SMS/push notifications, and an administrative panel for system management. The project aims to provide a comprehensive tool for sports bettors, enhancing their decision-making with data-driven insights.

## User Preferences
I prefer clear and concise explanations. When implementing new features or making significant changes, please propose the high-level plan first and wait for my approval before proceeding with detailed implementation. For UI/UX, I prefer modern, clean designs with intuitive navigation. I am open to iterative development and feedback loops.

## System Architecture

### Frontend
- **Frameworks**: React with Vite for fast development, Tailwind CSS for styling, and `shadcn/ui` for UI components.
- **Data Fetching**: TanStack Query manages server state.
- **Forms**: `react-hook-form` is used for form management.
- **Routing**: `wouter` provides a lightweight routing solution.
- **UI/UX**:
    - **Tab Structure**: A top tab bar for NBA Live, NCAAB Live, and MLB Live. Sub-tabs appear based on the main sport selected (e.g., "Live Props," "2H Plays"). MLB uses 4-tab navigation: Games / Live Edge Feed / Inning Edge Feed / HR Radar.
    - **Tier Access**: NCAAB tab access is controlled by subscription tier, unlocking features for Pro/All Sports users.
    - **Book Filtering**: NBA 2H Plays include a book filter with pills (All, DK, FD, MGM, BR, ESPN) that persists across sub-tabs but resets on sport tab switch.
    - **NCAAB Game Card**: Features market buttons (Over/Under/Spread), radial probability gauges, EV verdicts, and CLV indicators.
    - **Daily Slate Reset**: A system for clearing daily state, triggering a full-screen "New Slate Loading" overlay with progress animation and configurable reset times via an admin panel.
    - **Team Total Market**: Over/Under team-total buttons are embedded in projection rows, driven by `selectedTeamMarket` state.
    - **H2H Matchup History**: Displays historical game results and spread coverage for teams.
    - **NCAAB Games Strip**: A horizontal scrollable chip bar showing live scores and scheduled times, allowing quick navigation to specific games.
    - **Welcome Experience**: New Pro users see a `WelcomeBanner` and a "NEW" badge on the NCAAB tab for a limited time post-upgrade.
    - **Mobile UX**: Parlay Slip functions as a bottom sheet on mobile and a side column on desktop. Pull-to-refresh gesture on mobile/PWA triggers subscription tier refresh + full data reload.
    - **PWA Updates**: Service worker (`sw.js`, cache `livelocks-v6`) uses client-driven `skipWaiting` lifecycle. `main.tsx` checks for updates on page load, visibility change, and every 5 minutes. Navigation requests use network-first strategy with offline fallback. `overscroll-behavior-y: none` prevents native pull-to-refresh conflicts.
    - **Engine-Calibrated Probabilities**: Probabilities are calibrated server-side by the NCAAB engine (normal CDF with calibration cap at 78%, early-game neutral at 50%). Client displays engine values directly.
    - **Neutral State Handling**: If game progress is low and probabilities are near 50%, a "Insufficient Data" verdict is displayed.

### Backend
- **Framework**: Express.js, written in TypeScript and executed with `tsx`.
- **Database**: PostgreSQL, managed with Drizzle ORM.
- **Shared Components**: `shared/schema.ts` for database schema and `shared/routes.ts` for API routes ensure type safety and consistency between frontend and backend.
- **Authentication**: JWT-based authentication with Bearer tokens stored in localStorage.
- **Access Control**: Role-based access control (`requireAuth`, `requireTier`, `requireAdmin`, `requirePlayAccess`) gates API endpoints by subscription tier. Tier mapping: Pro ($40/mo) → internal tier `"all"` → NBA + NCAAB + unlimited plays; All Sports ($65/mo) → tier `"elite"` → NBA + NCAAB + MLB + unlimited plays; Free → NBA only, 3 plays/day limit enforced atomically (consume-before-process). MLB routes require `requireTier("elite")`, NCAAB routes require `requireTier("all", "elite")`.
- **SMS Alerts**: Integrated with Twilio for sending SMS notifications and handling opt-out requests via webhooks.
- **NBA Probability Model**: Calculates player probabilities based on observed stats, season baseline, foul penalties, defensive ratings, and pace multipliers. Live-signals endpoint (`/api/live-signals/:gameId`) processes 11 stat types (points, rebounds, assists, threes, steals, blocks, pts_reb, pts_ast, pts_reb_ast, reb_ast, stl_blk) with parallel odds cache pre-warming via `preWarmOddsCache` to avoid sequential API timeouts.
- **NCAAB Engine** (`server/ncaabEngine.ts`): Single source of truth for all NCAAB projection, probability, pick direction, and display output. Uses normal CDF probability model (σ=12, market-specific variance), calibration cap at 78%, contradiction rejection (projection vs probability disagreement → NO_EDGE), deterministic edge rules (gap ≥ 2.0 pts AND prob ≥ 57%), dynamic multiplier clamped 0.6–1.4. Client renders exclusively from `NCAABEngineOutput` — no client-side recomputation. Diagnostics module (`server/ncaabDiagnostics.ts`) provides settled-play logging, calibration analysis, and drift detection.
- **MLB Prop Engine** (`server/mlb/`): Gold Master live prop engine for MLB player prop markets. Implements seven market calculators (Hits, Total Bases, Batter K, Pitcher K, Hits Allowed, HR, HRR) via a modular pipeline: types → feature engineering → projection → probability → calibration → market calculators. Key features:
    - **Form Indicator System**: `computeFormScore`/`classifyForm` evaluates recent AB quality to produce HOT/WARM/NEUTRAL/COLD form badges. `FormIndicator` type normalized to uppercase in API output.
    - **HR Qualifying Factors**: 7-factor gate (hardHitContact, favorableWind, hrPronePitcher, strongPitchMatchup, batterParkSuccess, fatiguePitcher, deepFlyout) requiring 3+ factors for HR signal qualification via `meetsHRQualificationGate`.
    - **Scout-Report Translation Layer**: `translateToScoutReport` converts raw stats to human-readable bullets (e.g. "2 Hard-Hit Balls (103+ EV)", "Pitcher Tiring", "Wind Out (12 mph)").
    - **Enhanced Signal Output**: Each signal includes `formIndicator`, `formScore`, `evPct` (expected value percentage), `hrFactors` (count + labels), `contextScore`, `matchupTag`, and `explanationBullets`.
    - **Tweet System**: `generateTweet` auto-formats signal data into copy-ready tweets with elite (full EV/HR/matchup detail) vs standard (basic) tier formatting.
    - **MLB UI Architecture**: Full rebuilt MLB page with NBA-quality product design. `MLBScheduleList` game grid shows pitcher heat emoji (🔥/🟡/❄️ based on pitch count/TTO), weather (temp + wind), venue, signal count badges. `GameDetailView` shows split scoreboard, pitcher context panel (pitches/TTO/velo/drop), weather row, edge signals, and team-split batter grids. `BatterCard` shows last AB outcome pills (H/K/BB/O), EV/Barrel%/xBA/Hard Hit contact metrics grid, and embedded engine signals. `SignalCard` shows whole-number probability, EV%, projection, line in 4-column grid with edge color-coding, HR factors, scout bullets, tweet button. Live Edge Feed aggregates top signals across all live games. Inning Edge Feed filters by 3rd/5th/7th inning progression. HR Radar activates only when 3-factor qualification gate passes.
    - **MLB Enriched Endpoints**: `live-games` includes structured `weather`, `pitcherContext`, `gameState`, `signalCount`. `live-stats` includes `teamSide`, `exitVelocity`, `barrelPct`, `xBA`, `xSLG`, `hardHitPct`, `priorABResults`. New `/api/mlb/edge-feed` aggregates top signals across all live games sorted by edge then probability.
    - **HR Tab**: Dedicated inning tab filter for HR/HRR market signals only, with orange-themed styling.
    - Enforces Two-AB Rule for live-form boost activation, with early explosive-contact mode. In-memory diagnostics framework tracks projection error and mode performance.
- **MLB Cross-Date Fix**: ESPN lists late-night US games (e.g. west coast 10PM+ ET) under yesterday's US date in their dated feed. Discovery service (`gameDiscoveryService.ts`) now fetches BOTH the today-dated ESPN feed AND the default active feed (no date param), merging by gameId to capture cross-date games. Also fetches yesterday's MLB Stats API schedule for gamePk resolution. The orchestrator (`liveGameOrchestrator.ts`) uses ESPN `STATUS_IN_PROGRESS` as a fallback when MLB Stats API `feed/live` returns empty for a gamePk, and fires the engine immediately on first poll when a game is detected as live.
- **Roster Sync**: An API endpoint to pull live ESPN rosters and map team abbreviations.

### Admin Panel
- Provides an interface to view users, manage subscription tiers, reset play counts, and review user feedback.
- Allows configuration of the daily slate reset time.

## External Dependencies

- **ESPN**: Primary source for live game data, scores, and player statistics.
- **The Odds API**: Provides spread/total book lines and American odds.
- **Sports Game Odds (SGO)**: Used for 1H lines and team total lines.
- **Stripe**: Payment gateway for subscription management, including product definitions and webhook processing.
- **Twilio**: SMS service for user alerts and notifications.
- **Resend**: Transactional email service for lifecycle emails (welcome, how-to, nudge, wall, winback, subscription welcome). Configured in `server/email.ts` with 7 send functions. Triggered on signup, 15th play, checkout, and daily cron (9 AM ET for nudge/winback). Dev test route at `GET /api/test-email`.
- **PostgreSQL**: Relational database for storing all application data.