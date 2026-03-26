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
    - **Tab Structure**: A top tab bar for NBA Live, NCAAB Live, and a locked MLB Live section. Sub-tabs appear based on the main sport selected (e.g., "Live Props," "2H Plays").
    - **Tier Access**: NCAAB tab access is controlled by subscription tier, unlocking features for Pro/All Sports users.
    - **Book Filtering**: NBA 2H Plays include a book filter with pills (All, DK, FD, MGM, BR, ESPN) that persists across sub-tabs but resets on sport tab switch.
    - **NCAAB Game Card**: Features market buttons (Over/Under/Spread), radial probability gauges, EV verdicts, and CLV indicators.
    - **Daily Slate Reset**: A system for clearing daily state, triggering a full-screen "New Slate Loading" overlay with progress animation and configurable reset times via an admin panel.
    - **Team Total Market**: Over/Under team-total buttons are embedded in projection rows, driven by `selectedTeamMarket` state.
    - **H2H Matchup History**: Displays historical game results and spread coverage for teams.
    - **NCAAB Games Strip**: A horizontal scrollable chip bar showing live scores and scheduled times, allowing quick navigation to specific games.
    - **Welcome Experience**: New Pro users see a `WelcomeBanner` and a "NEW" badge on the NCAAB tab for a limited time post-upgrade.
    - **Mobile UX**: Parlay Slip functions as a bottom sheet on mobile and a side column on desktop.
    - **Engine-Calibrated Probabilities**: Probabilities are calibrated server-side by the NCAAB engine (normal CDF with calibration cap at 78%, early-game neutral at 50%). Client displays engine values directly.
    - **Neutral State Handling**: If game progress is low and probabilities are near 50%, a "Insufficient Data" verdict is displayed.

### Backend
- **Framework**: Express.js, written in TypeScript and executed with `tsx`.
- **Database**: PostgreSQL, managed with Drizzle ORM.
- **Shared Components**: `shared/schema.ts` for database schema and `shared/routes.ts` for API routes ensure type safety and consistency between frontend and backend.
- **Authentication**: JWT-based authentication with Bearer tokens stored in localStorage.
- **Access Control**: Role-based access control (e.g., `requireAuth`, `requireTier`, `requireAdmin`) is implemented for API endpoints to manage feature access based on user subscription tiers and admin status.
- **SMS Alerts**: Integrated with Twilio for sending SMS notifications and handling opt-out requests via webhooks.
- **NBA Probability Model**: Calculates player probabilities based on observed stats, season baseline, foul penalties, defensive ratings, and pace multipliers.
- **NCAAB Engine** (`server/ncaabEngine.ts`): Single source of truth for all NCAAB projection, probability, pick direction, and display output. Uses normal CDF probability model (σ=12, market-specific variance), calibration cap at 78%, contradiction rejection (projection vs probability disagreement → NO_EDGE), deterministic edge rules (gap ≥ 2.0 pts AND prob ≥ 57%), dynamic multiplier clamped 0.6–1.4. Client renders exclusively from `NCAABEngineOutput` — no client-side recomputation. Diagnostics module (`server/ncaabDiagnostics.ts`) provides settled-play logging, calibration analysis, and drift detection.
- **MLB Prop Engine** (`server/mlb/`): Phase A live prop engine for MLB player prop markets. Implements seven market calculators (Hits, Total Bases, Batter K, Pitcher K, Hits Allowed, HR [experimental], HRR [experimental]) via a modular pipeline: types → feature engineering (contact quality, lineup context, pitcher fatigue, weather/park) → projection → probability (Normal CDF with per-market sigma) → calibration (sigmoid shrinkage capped at 18–82%) → market calculators. Enforces Two-AB Rule for live-form boost activation, with early explosive-contact mode for elite single-AB contact quality. All modifiers individually capped before summing. In-memory diagnostics framework tracks projection error, edge distribution, win rate by confidence tier, and mode performance. Routes: `GET /api/mlb/props` (tier-gated), `GET /api/mlb/diagnostics` (admin-only). Phase B: live data scrapers, odds integration, frontend UI, settlement.
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