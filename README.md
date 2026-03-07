# LiveLocks by PropPulse

Real-time sports betting analytics for NBA and NCAAB. Live prop probabilities, halftime 2H plays, full-slate NCAAB coverage, and automatic edge detection in the live box score.

**Live at**: `https://livelocks.replit.app`

---

## What It Does

LiveLocks pulls real-time game data, live box scores, and sportsbook odds to compute the probability of a player hitting a live prop line. It factors in current pace, defensive matchup, foul trouble, and game context — giving you an edge the sportsbook doesn't show you.

### Key Features

- **Live NBA box score** with real-time stats, color-coded row/cell highlights when the engine detects an edge on a player's prop line (any quarter, not just halftime)
- **Live prop calculator** — click any player row to auto-fill; probability gauge updates instantly
- **NBA 2H Plays** — halftime engine scans all live halftime games, runs each player's remaining-game probability against real book lines, surfaces top plays sorted by edge confidence
- **NCAAB full slate** — all Division I games daily, live scores, 2H plays with spread/total/team-total projections, H2 engine vs. book comparison
- **Parlay builder** — correlation-adjusted parlays with deeplinks to DraftKings, FanDuel, Hard Rock
- **Multi-channel alerts** — web push and SMS (Pro/All Sports) for high-confidence plays
- **PWA** — installable on mobile, works offline for cached content

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
│       │   ├── dashboard.tsx        # Main app — NBA/NCAAB calculator, box score, parlay
│       │   ├── admin.tsx            # Admin panel (user management, feedback, slate reset)
│       │   ├── auth.tsx             # Login / Register
│       │   └── not-found.tsx
│       ├── components/
│       │   ├── ncaab-admin-tab.tsx  # Full NCAAB live tab component
│       │   ├── parlay-slip.tsx      # Parlay builder
│       │   ├── upgrade-modal.tsx    # Paywall modal
│       │   ├── feedback-modal.tsx   # User feedback form
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
│   ├── ncaabService.ts              # NCAAB full-slate engine
│   ├── alertManager.ts              # Push + SMS alert dispatch
│   ├── parlayService.ts             # Parlay correlation engine
│   ├── stripeService.ts             # Stripe checkout + subscription sync
│   ├── stripeClient.ts              # Stripe SDK client
│   └── webhookHandlers.ts           # Stripe + Twilio webhook handlers
├── shared/
│   ├── schema.ts                    # Drizzle schema + Zod types (shared)
│   └── routes.ts                    # API route constants (shared)
├── PRD.md                           # Full product requirements document
├── README.md                        # This file
└── replit.md                        # Architecture notes for Replit agent
```

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
| `TWILIO_ACCOUNT_SID` | Alerts | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Alerts | Twilio auth token |
| `TWILIO_FROM_NUMBER` | Alerts | Twilio sender number (E.164 format) |
| `VAPID_PUBLIC_KEY` | Push | Web Push VAPID public key |
| `VAPID_PRIVATE_KEY` | Push | Web Push VAPID private key |

---

## Authentication

- Email + password (bcrypt, 10 rounds)
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
| Free | $0 | `null` | 15 probability calculations then paywall |
| Pro | $40/mo | `"all"` | Unlimited NBA + NCAAB live + 2H Plays + SMS + Push |
| All Sports | $65/mo | `"elite"` | Everything in Pro + MLB Live (coming soon) + Priority SMS |
| Admin | — | — | Full access, no limits |

---

## Key API Endpoints

### Auth
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth/register` | Create account |
| `POST` | `/api/auth/login` | Login (email or phone) |
| `POST` | `/api/auth/logout` | Clear session |
| `GET` | `/api/auth/me` | Current user |

### NBA
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/calculate` | Run prop probability (play-gated for free users) |
| `GET` | `/api/live-games` | ESPN NBA scoreboard (30s cache) |
| `GET` | `/api/live-stats/:gameId` | Live box score for a specific game |
| `GET` | `/api/live-signals/:gameId` | Live prop edge signals for box score coloring (90s cache) |
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

## Probability Model

### NBA Live Props

1. **Blended rate**: `observedRate × 0.7 + seasonBaseline × 0.3`
2. **Foul penalty**: 3 fouls = 30% minute reduction; 4+ fouls = 55% reduction
3. **Remaining minutes**: projected from current period + game clock
4. **Expected total**: `currentStat + (projectedMinutes × blendedRate)`
5. **Defense adjustment**: opponent `defRating` (0.88–1.12 scale)
6. **Pace adjustment**: blends team historical pace with live game pace (score-based)
7. **Probability**: `50 + difference × scaleFactor` (clamped 2–98%)

Scale factors: points=8, rebounds/assists=10, steals/blocks=15, combos=6

### Live Box Score Edge Signals (`/api/live-signals/:gameId`)

Runs on the currently viewed game during any quarter (Q1–Q4), not just halftime:
- For each player with ≥3 minutes, checks 5 prop markets: Points, Rebounds, Assists, Threes, PRA
- Fetches real book lines (Odds API → SGO fallback) — never fabricates a line
- Runs the probability engine with the actual current period and game clock
- Returns signals with an edge of ≥5% from 50%
- Result is cached for 90 seconds

**Color tiers in the box score:**

| Color | Condition |
|-------|-----------|
| Green | ≥85% hit implied (OVER) |
| Red | ≥85% hit implied (UNDER) |
| Yellow | 70–84% hit implied |
| Teal | 60–69% hit implied |

### NBA 2H / Halftime Engine

Scans all live halftime games simultaneously. For each player at halftime:
- Checks all 11 stat type combinations
- Uses median consensus line across available books
- Runs `calculateProbability` with `currentPeriod: 3, gameClock: "12:00"` (start of 2H)
- Returns top 20 plays sorted by edge descending
- Triggers push/SMS alerts for plays with ≥85% confidence (first occurrence per player/stat/line per session)

---

## Data Sources

| Source | Data | Refresh |
|--------|------|---------|
| ESPN API | Live scores, box scores, injuries, rosters | 30–90s |
| The Odds API | Prop lines (DK, FD, HR, FanDuel, ESPN Bet) | 90s live / 5min pre-game |
| Sports Game Odds (SGO) | NCAAB 1H lines, team totals, fallback prop lines | 5 min |
| NBA.com / ESPN stats | Season per-game averages, H2 splits | Daily (sync on demand) |

---

## Live Box Score Coloring

When you open the box score for any live NBA game, the app:
1. Fetches `/api/live-signals/:gameId` (90s cache)
2. For each player with a detected edge, color-codes:
   - **The row background** — the best signal across any of the player's props
   - **The active stat column cell** — the signal for the currently selected stat type
3. Switching the stat column (PTS → AST → PRA etc.) instantly remaps cell colors
4. Zero extra API calls on the frontend — signals are pre-computed server-side

---

## Mobile UX

- **PWA**: Installable from browser (Android/iOS)
- **Header**: On screens < 640px, hides Sync Rosters, live counter, plays badge. Shows logo + Parlay Slip button only
- **Parlay Slip**: Bottom sheet on mobile, side column on desktop
- **Auth**: JWT in localStorage — works in mobile browsers, PWA, and cross-origin contexts

---

## Checkpoints

| Checkpoint | Description |
|-----------|-------------|
| `e6d58886523a1fb879e0abe54e1b579fa233d686` | Production deployment — live signals + NCAAB 2H engine |
| `b9f431cd22f951b4f7aef34657876ee01dcdc336` | Stable NBA baseline pre-NCAAB |

To roll back: open Replit chat and ask to revert to a commit ID.

---

## Roadmap

- MLB Live integration (All Sports tier gate already in place)
- Player prop trend charts / historical hit rate
- User notification history log
- NFL Live (future)
