# LiveLocks by PropPulse

Real-time sports betting analytics for NBA, NCAAB, and MLB. Live prop probabilities, halftime 2H plays, full-slate NCAAB coverage, MLB Phase A engine with distribution models, and automatic edge detection in the live box score.

**Live at**: `https://livelocks.replit.app`

---

## What It Does

LiveLocks pulls real-time game data, live box scores, and sportsbook odds to compute the probability of a player hitting a live prop line. It uses archetype-based classification, distribution-specific probability models, fragility scoring, calibration pipelines, and game-state intelligence — giving you an edge the sportsbook doesn't show you.

### Key Features

- **Live NBA box score** with real-time stats, inline market badges with rotation showing per-market edges (Points, Rebounds, Assists, Threes, PRA) for 10-second quick scanning
- **NBA archetype engine** — 7 player archetypes (stable_star through role_uncertain) with Z-score / Normal CDF probability, 3-source blended rates, fragility scoring, calibration shrinkage, and safety ceilings
- **Live prop calculator** — click any player row to auto-fill; probability gauge updates instantly
- **NBA 2H Plays** — halftime engine scans all live halftime games, runs each player's remaining-game probability against real book lines, surfaces top plays sorted by edge confidence
- **NCAAB full slate** — all Division I games daily, live scores, canonical market objects (Full Game, H1, H2), Top Plays feed, book filter pills (All / DK / FD / HR / ESPN Bet), CLV edge + public bet fade layer, confidence tiers (ELITE/STRONG/VALUE/NONE)
- **MLB Phase A engine** — 10 prop markets with distribution-first architecture (Negative Binomial, Binomial, Normal CDF), 8 batter archetypes + 6 pitcher archetypes, Statcast-driven classification, PA distribution model, live game cards
- **Conversion engine** — daily play reset for free users (3 plays/day), teaser values on blurred plays, upgrade CTAs, Recent Wins strip, edge feed conversion gate
- **Email lifecycle** — Resend transactional email with verification flow, auto-login after verification, lifecycle cron, ROI wall email
- **Play grading + calibration dashboard** — persisted plays with automated grading, track record display, ROI metrics (admin-only)
- **Admin simulation mode** — test probability calculations with synthetic inputs without affecting live data
- **Landing page** — public marketing page at `/` with real product screenshots, feature highlights, pricing cards, and CTA
- **Signal stability filters** — low-minute bench volatility dampener, high-usage UNDER collapse guard, combo-stat variance dampener
- **Parlay builder** — correlation-adjusted parlays with deeplinks to DraftKings, FanDuel, Hard Rock
- **Multi-channel alerts** — web push and SMS (Pro/All Sports) for high-confidence plays
- **PWA** — installable on mobile, works offline for cached content
- **SEO metadata** — OpenGraph and Twitter card tags on all public pages
- **Tweet template system** — rotating templates for sharing engine picks on social media

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite, TypeScript |
| Styling | Tailwind CSS, shadcn/ui |
| Data fetching | TanStack Query v5 |
| Forms | react-hook-form + zod |
| Routing | wouter |
| Backend | Express.js, TypeScript, tsx |
| Database | PostgreSQL via Drizzle ORM |
| Auth | bcrypt + JWT (localStorage) + Express sessions |
| Payments | Stripe (replit-stripe-sync integration) |
| Email | Resend (transactional email + verification) |
| SMS | Twilio |
| Push | Web Push API (VAPID) |
| Deployment | Replit Deployments |

---

## Project Structure

```
/
├── client/
│   ├── public/
│   │   ├── sw.js                    # Service worker (PWA + push notifications)
│   │   └── manifest.json            # PWA manifest
│   └── src/
│       ├── pages/
│       │   ├── landing.tsx          # Public marketing landing page
│       │   ├── dashboard.tsx        # Main app — NBA/NCAAB/MLB calculator, box score, parlay
│       │   ├── admin.tsx            # Admin panel (user management, feedback, simulation, calibration)
│       │   ├── auth.tsx             # Login / Register with email verification
│       │   ├── verify-pending.tsx    # Email verification pending / landing
│       │   ├── privacy.tsx          # Privacy policy
│       │   ├── terms.tsx            # Terms of service
│       │   └── not-found.tsx
│       ├── components/
│       │   ├── DashboardPreview.tsx # Landing page dashboard preview
│       │   ├── ncaab-admin-tab.tsx  # Full NCAAB live tab component
│       │   ├── mlb-admin-tab.tsx    # MLB live tab component
│       │   ├── parlay-slip.tsx      # Parlay builder
│       │   ├── upgrade-modal.tsx    # Paywall modal
│       │   ├── feedback-modal.tsx   # User feedback form
│       │   ├── RecentWinsStrip.tsx   # Recent Wins display
│       │   ├── alerts-onboarding-modal.tsx  # Post-login alert opt-in
│       │   ├── welcome-banner.tsx   # New-user welcome banner
│       │   ├── probability-ring.tsx # Circular probability gauge
│       │   ├── stat-card.tsx        # Stat display card
│       │   ├── analytics-tab.tsx    # Analytics view
│       │   └── ui/                  # shadcn/ui components
│       ├── hooks/
│       │   ├── use-auth.ts          # Auth state + JWT
│       │   └── use-nba.ts           # NBA data fetching hooks
│       └── lib/
│           └── queryClient.ts       # TanStack Query + JWT auth headers
├── server/
│   ├── index.ts                     # Express app setup, session, Stripe sync
│   ├── routes.ts                    # All API endpoints + data scrapers
│   ├── auth.ts                      # JWT, bcrypt, requireAuth/requireTier middleware
│   ├── storage.ts                   # Database interface (Drizzle)
│   ├── db.ts                        # Drizzle client
│   ├── oddsService.ts               # The Odds API + SGO integration
│   ├── ncaabService.ts              # NCAAB full-slate service
│   ├── ncaabEngine.ts               # NCAAB probability engine (pace-based model)
│   ├── alertManager.ts              # Push + SMS alert dispatch
│   ├── parlayService.ts             # Parlay correlation engine
│   ├── stripeService.ts             # Stripe checkout + subscription sync
│   ├── stripeClient.ts              # Stripe SDK client
│   ├── webhookHandlers.ts           # Stripe + Twilio webhook handlers
│   ├── email.ts                     # Resend transactional email
│   ├── nba/                         # NBA archetype probability engine
│   │   ├── probabilityEngine.ts     # Z-score/Normal CDF probability + calibration
│   │   ├── archetypes.ts            # 7 player archetypes + classification
│   │   ├── directionalBias.ts       # Under-bias correction
│   │   └── marketFamily.ts          # Market family categorization
│   ├── services/                    # Shared engine services
│   │   ├── engineInputBuilder.ts    # Unified engine input construction
│   │   ├── engineSignal.ts          # Signal output + confidence tiers
│   │   ├── engineValidation.ts      # Validation firewall
│   │   ├── engineStats.ts           # Engine observability stats
│   │   ├── gradePersistedPlays.ts   # Automated play grading
│   │   ├── playTracker.ts           # Play persistence + tracking
│   │   ├── consensusLineService.ts  # Consensus line computation
│   │   ├── sportsbookService.ts     # Sportsbook data service
│   │   ├── timingService.ts         # Freshness + timing gates
│   │   ├── normalizationService.ts  # Abbreviation + data normalization
│   │   ├── topPlaysService.ts       # Top plays ranking
│   │   ├── minutesProjectionService.ts # Projected minutes ingestion
│   │   └── bartTorvik.ts            # NCAAB advanced stats
│   └── mlb/                         # MLB probability engine
│       ├── probabilityEngine.ts     # Distribution-first probability (NegBin, Binomial, Normal)
│       ├── archetypes.ts            # 8 batter + 6 pitcher archetypes
│       ├── types.ts                 # MLB type definitions
│       ├── markets.ts               # 10 prop market configs
│       ├── featureEngineering.ts    # Contact-quality + Statcast features
│       ├── hitProbabilityModel.ts   # xBA/xSLG hit probability model
│       ├── paEstimator.ts           # PA distribution estimator
│       ├── paDistribution.ts        # PA distribution model
│       ├── outcomeDistribution.ts   # Neg Binomial + Binomial implementations
│       ├── integrityFirewall.ts     # Output validation firewall
│       ├── calibration.ts           # Archetype-aware calibration
│       ├── signalScore.ts           # Signal scoring + tiers
│       ├── rosterService.ts         # MLB roster sync from ESPN
│       ├── dataSources.ts           # External data source adapters
│       ├── dataPullService.ts       # Periodic data pull orchestration
│       ├── gameDiscoveryService.ts  # Live game detection
│       ├── liveGameOrchestrator.ts  # Continuous live game polling
│       ├── liveGameRegistry.ts      # Active game state registry
│       ├── edgeCache.ts             # Edge signal caching + TTL
│       ├── backtestHarness.ts       # Backtest framework
│       └── diagnostics.ts          # Debug and diagnostic utilities
├── shared/
│   ├── schema.ts                    # Drizzle schema + Zod types (shared)
│   └── routes.ts                    # API route constants (shared)
├── PRD.md                           # Full product requirements document (v5.0)
├── CHANGELOG.md                     # Reverse-chronological project changelog (Tasks #1–#114)
├── README.md                        # This file
├── NBA_Model_Logic.md               # NBA archetype engine behavior doc
├── MLB_Engine_Logic.md              # MLB distribution engine behavior doc
├── NCAAB_Engine_Logic.md            # NCAAB pace-based engine behavior doc
└── replit.md                        # Architecture notes for Replit agent
```

---

## Routes

| Path | Visibility | Description |
|------|-----------|-------------|
| `/` | Public | Landing page (redirects to `/dashboard` if authenticated) |
| `/landing` | Public | Landing page (direct access) |
| `/auth` | Public | Login / Register |
| `/verify-pending` | Public | Email verification pending page |
| `/dashboard` | Authenticated | Main application (NBA, NCAAB, MLB tabs) |
| `/admin` | Admin | Admin panel |
| `/privacy` | Public | Privacy policy |
| `/terms` | Public | Terms of service |

---

## Getting Started

The project runs automatically on Replit via the `Start application` workflow (`npm run dev`).

```bash
npm install
npm run dev
```

Server starts on port 5000. Vite serves the frontend through the same Express process.

---

## Environment Variables

Set these in Replit's Secrets panel:

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SESSION_SECRET` | Yes | Express session + JWT signing secret |
| `ADMIN_EMAIL` | Yes | Email for the admin account |
| `ODDS_API_KEY` | Yes | The Odds API key (for prop lines and game lines) |
| `SGO_API_KEY` | Yes | Sports Game Odds API key (NCAAB lines fallback) |
| `STRIPE_SECRET_KEY` | Yes | Stripe server-side secret key |
| `VITE_STRIPE_PUBLISHABLE_KEY` | Yes | Stripe publishable key (frontend) |
| `RESEND_API_KEY` | Yes | Resend API key (transactional email) |
| `TWILIO_ACCOUNT_SID` | Alerts | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Alerts | Twilio auth token |
| `TWILIO_FROM_NUMBER` | Alerts | Twilio sender number (E.164 format) |
| `VAPID_PUBLIC_KEY` | Push | Web Push VAPID public key |
| `VAPID_PRIVATE_KEY` | Push | Web Push VAPID private key |

---

## Authentication

- Email + password (bcrypt, 10 rounds)
- Email verification required after registration (via Resend)
- Auto-login after email verification with dashboard toast
- On login: server returns a signed JWT (30-day expiry) alongside the session cookie
- Frontend stores JWT in `localStorage` as `ll_auth_token`
- Every API request sends `Authorization: Bearer <token>` header
- Server accepts either Bearer token or session cookie — whichever is present
- This dual approach makes auth work on mobile, in iframes, and across cross-origin contexts

### Admin Setup

1. Set `ADMIN_EMAIL` in environment variables
2. Register an account with that exact email
3. Account is granted `isAdmin = true` and unlimited access

---

## Subscription Tiers

| Tier | Price | Internal Key | Access |
|------|-------|-------------|--------|
| Free | $0 | `null` | 3 probability calculations per day (daily reset), then paywall |
| Pro | $40/mo | `"all"` | Unlimited NBA + NCAAB live + 2H Plays + SMS + Push |
| All Sports | $65/mo | `"elite"` | Everything in Pro + MLB Live + Priority SMS |
| Admin | — | — | Full access, no limits |

---

## Engine Documentation

Detailed engine behavior docs are maintained separately:

| Document | Description |
|----------|-------------|
| [NBA_Model_Logic.md](NBA_Model_Logic.md) | Archetype classification, Z-score probability, fragility scoring, calibration, safety ceilings |
| [MLB_Engine_Logic.md](MLB_Engine_Logic.md) | Distribution models (NegBin/Binomial/Normal), batter/pitcher archetypes, PA distribution, Statcast classification |
| [NCAAB_Engine_Logic.md](NCAAB_Engine_Logic.md) | Pace-based projection, dynamic multiplier, CLV edge, public bet fade, confidence tiers |

---

## Key API Endpoints

### Auth
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth/register` | Create account |
| `POST` | `/api/auth/login` | Login (email or phone) |
| `POST` | `/api/auth/logout` | Clear session |
| `GET` | `/api/auth/me` | Current user |
| `GET` | `/api/auth/verify-email` | Verify email token |

### NBA
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/calculate` | Run prop probability (play-gated for free users) |
| `GET` | `/api/live-games` | ESPN NBA scoreboard (30s cache) |
| `GET` | `/api/live-stats/:gameId` | Live box score for a specific game |
| `GET` | `/api/live-signals/:gameId` | Live prop edge signals for box score (90s cache) |
| `GET` | `/api/odds` | Player prop lines from The Odds API |
| `GET` | `/api/game-lines` | Game spread and total |
| `GET` | `/api/injuries` | NBA injury report |
| `GET` | `/api/halftime-plays` | Best plays across all live halftime games |
| `POST` | `/api/parlay/calculate` | Parlay correlation calculation |

### NCAAB
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/ncaab/games` | Full Division I slate (all live + scheduled) |
| `GET` | `/api/ncaab/plays` | Computed NCAAB 2H plays with probabilities |

### MLB
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/mlb/live-games` | MLB game schedule + live scores |
| `GET` | `/api/mlb/live-signals/:gameId` | MLB player signals for a game |
| `GET` | `/api/mlb/edge-feed` | MLB cross-game edge feed |
| `POST` | `/api/mlb/calculate-manual` | MLB manual prop calculation |

### Admin
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/sync-rosters` | Trigger ESPN roster sync |
| `GET` | `/api/admin/users` | User list |
| `PATCH` | `/api/admin/users/:id/tier` | Set subscription tier |
| `PATCH` | `/api/admin/users/:id/reset-plays` | Reset play counter |

### Stripe
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/stripe/create-checkout-session` | Start checkout |
| `POST` | `/api/stripe/portal` | Open billing portal |
| `POST` | `/api/webhooks/stripe` | Stripe event handler |
| `POST` | `/api/webhooks/twilio` | SMS STOP opt-out handler |

---

## Data Sources

| Source | Data | Refresh |
|--------|------|---------|
| ESPN API | Live scores, box scores, injuries, rosters (NBA + NCAAB + MLB) | 30–90s |
| The Odds API | Prop lines (DK, FD, Hard Rock Bet, PrizePicks, Underdog Fantasy) | 90s live / 5min pre-game |
| Sports Game Odds (SGO) | NCAAB 1H lines, team totals, fallback prop lines | 5 min |
| NBA.com / ESPN Stats | Season per-game averages, H2 splits | Daily (sync on demand) |
| Baseball Savant | Statcast metrics (xBA, barrel rate, exit velocity) for MLB archetypes | Daily |

---

## Mobile UX

- **PWA**: Installable from browser (Android/iOS)
- **Header**: On screens < 640px, hides Sync Rosters, live counter, plays badge. Shows logo + Parlay Slip button only
- **Parlay Slip**: Bottom sheet on mobile, side column on desktop
- **Auth**: JWT in localStorage — works in mobile browsers, PWA, and cross-origin contexts

---

## Roadmap

| Priority | Feature | Status |
|----------|---------|--------|
| High | MLB Phase B — expanded public markets, enhanced live game cards | Planned |
| High | Player prop trend charts / historical hit rate | Planned |
| Medium | Parlay builder deep-link improvements | Partial (DK/FD/HR/Bet365 live) |
| Medium | User notification history log | Planned |
| Low | NFL Live integration | Future |
| Low | Mobile app (React Native) | Future |
