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
- **NCAAB Engine**: Provides projections, probabilities (normal CDF model), and pick directions with deterministic edge rules. Features a diagnostics module and a `qualifiedEdge`/`fallback` architecture for market surfacing, applying weighted scoring for Top Plays and color-coded confidence tiers (ELITE, STRONG, LEAN). Halftime cards show live 2H context.
- **MLB Prop Engine**: Processes various MLB player prop markets (Hits, Total Bases, Batter K, Pitcher K, Hits Allowed, HR) via a modular pipeline. Features a form indicator system, HR qualifying factors, scout-report translation, and a `SignalScore` system for confidence tiers (ELITE, STRONG, SOLID, WATCHLIST, NO_SIGNAL) based on a probability-first approach. Signals are ranked and styled by tier on the frontend.
- **MLB Signal Pipeline**: Employs a clean ENGINE → NORMALIZER → API → UI CARD pipeline with a single source of truth (`MLBSignal` interface). `normalizeMLBSignal()` transforms engine output into a flat `MLBSignal` with sided probability selection, market alias normalization, current stat computation, `alreadyHit` detection, pitch mix fallback, smart tag generation, and primary reason generation.
- **MLB HR Market Fallback**: `resolveBookLine()` in `liveGameOrchestrator.ts` falls back to a line of 0.5 for `home_runs` when no real line is available, aligning with the industry standard for HR O/U.
- **Simplified MLB Card UX**: `MlbSignalCard.tsx` redesigned for quick decision-making, offering a collapsed view with key signal info and an expanded view for detailed metrics, contact quality, driver breakdown, pitcher arsenal, BvP history, and risk flags. Smart tags and primary reasons are server-computed.
- **MLB Intelligence Layer**: Implements an archetype-driven intelligence pipeline with 8 batter and 6 pitcher archetypes, including variance multipliers, fragility thresholds, thesis generation, and market family suppression with penalty factors for derivatives. Features directional bias tracking with drift detection and archetype-specific safety ceilings.
- **MLB Probability Engine (v2.1)**: Pure probability computation module with no access to book lines. Computes model probability from projection, threshold, and market variance using market-specific distribution methods (normal CDF, negative binomial, binomial). Calibration and safety ceiling application are integrated.
- **MLB Distribution-First Engine Upgrade**: Core MLB markets (hits, total_bases, pitcher_strikeouts, home_runs) rewritten from heuristic math to market-specific outcome-distribution math. New modules for event rates, PA/BF distributions, and outcome distributions. Incorporates calibration shrinkage, market probability ceilings, and edge vs book implied calculations. Includes trust gating for projection quality.
- **MLB Phase 2 Engine Rebuild**: Features a spec-compliant feature layer with 11 normalized scores (e.g., contactQuality, batSpeedPower, handednessMatchup). Market engines in `markets.ts` use weighted formulas. A badge system populates canonical `badges[]`/`riskFlags[]`. An integrity firewall enforces probability ceilings and qualification floors. Confidence score uses a 5-component weighted formula. Event-driven recalculation triggers for high-impact game events.
- **MLB UI Architecture (NBA-mirrored rebuild)**: Dashboard with sub-tabs [Games | Live Feed | HR Radar]. **Games tab** features a horizontal game chip strip and a two-panel layout for selected games, displaying game context and active signals via `MlbSignalCard`. **Live Feed tab** shows `TopPlays` and `LiveBoard` (tier-grouped). **HR Radar tab** focuses on HR edges and activity. **Unified `MlbSignalCard`** is used across all views, collapsing by default and expanding to show detailed info. Includes a signal state machine and floating bet slip.
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
- **The Odds API**: Spread/total book lines, American odds.
- **Sports Game Odds (SGO)**: 1H lines, team total lines.
- **Stripe**: Payment gateway for subscriptions.
- **Twilio**: SMS notifications.
- **Resend**: Transactional email service.
- **PostgreSQL**: Application data storage.