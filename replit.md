# LiveLocks by PropPulse — NBA/NCAAB Live Lines

## Overview
LiveLocks is a full-stack Progressive Web Application (PWA) designed for betting analytics in NBA and NCAAB. It provides real-time probabilities for player prop bets, analyzes NCAAB live spread/total/team-total probabilities, and enables users to construct correlation-adjusted parlays. The platform integrates live game data from various sports data providers and offers Stripe-based subscriptions, SMS/push notifications, and an administrative panel. The project's vision is to enhance sports bettors' decision-making with data-driven insights and sophisticated analytical tools.

## User Preferences
I prefer clear and concise explanations. When implementing new features or making significant changes, please propose the high-level plan first and wait for my approval before proceeding with detailed implementation. For UI/UX, I prefer modern, clean designs with intuitive navigation. I am open to iterative development and feedback loops.

## System Architecture

### Frontend
- **Frameworks**: React with Vite, Tailwind CSS, and `shadcn/ui`.
- **Data Fetching**: TanStack Query.
- **Forms**: `react-hook-form`.
- **Routing**: `wouter`.
- **UI/UX**: Features a top tab bar for sports (NBA Live, NCAAB Live, MLB Live) with sub-tabs for specific analyses. Subscription tiers control access to certain features (e.g., NCAAB tab for Pro/All Sports users). Includes book filtering, probability gauges, EV verdicts, CLV indicators, and H2H matchup history. A daily slate reset system with an admin-configurable reset time. Mobile-optimized components like a Parlay Slip bottom sheet and pull-to-refresh functionality. PWA updates are handled by a service worker with client-driven `skipWaiting` and a network-first strategy for navigation.
- **Probabilities**: Engine-calibrated probabilities are displayed directly from the server.

### Backend
- **Framework**: Express.js with TypeScript and `tsx`.
- **Database**: PostgreSQL with Drizzle ORM.
- **Shared Components**: `shared/schema.ts` and `shared/routes.ts` for type safety.
- **Authentication**: JWT-based authentication with role-based access control tied to subscription tiers (Free, Pro, All Sports).
- **Notifications**: Twilio for SMS alerts. Resend for transactional emails (welcome, lifecycle, subscription).
- **NBA Probability Model**: Calculates player probabilities based on various statistical factors, with parallel odds cache pre-warming.
- **NCAAB Engine**: A single source of truth for NCAAB projections, probabilities, and pick directions, utilizing a normal CDF probability model and deterministic edge rules. Includes a diagnostics module for logging and analysis.
- **MLB Prop Engine**: Processes MLB player prop markets (Hits, Total Bases, Batter K, Pitcher K, Hits Allowed, HR, HRR) through a modular pipeline. Key features include a form indicator system, HR qualifying factors, scout-report translation, and a `SignalScore` system for confidence tiers (ELITE, STRONG, SOLID, WATCHLIST, NO_SIGNAL). Signal qualification uses a probability-first approach (≥60% probability gate).
- **MLB Cross-Date Fix**: Logic to handle ESPN's cross-date listing of late-night games by merging data from multiple ESPN feeds and MLB Stats API.
- **Roster Sync**: API endpoint to synchronize ESPN rosters and team abbreviations.

### Decision Engine Dashboard
- **Live Edge Feed**: Collapsible button displaying cross-sport edge cards ranked by edge and probability.
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