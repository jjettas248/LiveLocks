# LiveLocks by PropPulse

Live sports analytics and betting tool for sharper in-game prop decisions. Currently covers NBA with MLB coming soon.

**Live at**: Your `.replit.app` deployment URL  
**Stable checkpoint**: `b9f431cd22f951b4f7aef34657876ee01dcdc336`

---

## What It Does

LiveLocks pulls real-time game data, live box scores, and sportsbook odds to calculate the probability of a player hitting a live prop line. It factors in current pace, defensive matchup, foul trouble, and pace — giving you an edge the sportsbook doesn't show you.

Key capabilities:
- Live NBA game strip with real-time scores and clock
- Click any player in the live box score to auto-fill the calculator
- Probability engine blending observed rate + season baseline + defensive adjustment
- Parlay builder with correlation adjustments and implied odds
- Sportsbook deeplinks to DraftKings, FanDuel, Hard Rock
- Halftime best plays scanner
- Twitter/X share with `@proppulsebets` attribution

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
| Deployment | Replit (`.replit.app`) |

---

## Project Structure

```
/
├── client/
│   └── src/
│       ├── pages/
│       │   ├── dashboard.tsx    # Main calculator + parlay + live games
│       │   ├── admin.tsx        # Admin panel (user management, feedback)
│       │   ├── auth.tsx         # Login / Register
│       │   └── not-found.tsx
│       ├── components/
│       │   ├── parlay-slip.tsx  # Parlay builder component
│       │   ├── upgrade-modal.tsx# Paywall modal
│       │   ├── feedback-modal.tsx
│       │   └── ui/              # shadcn/ui components
│       ├── hooks/
│       │   ├── use-auth.ts      # Auth state + JWT
│       │   └── use-nba.ts       # All data fetching hooks
│       └── lib/
│           └── queryClient.ts   # TanStack Query + JWT auth headers
├── server/
│   ├── index.ts                 # Express app setup, session config
│   ├── routes.ts                # All API endpoints + data scrapers
│   ├── auth.ts                  # JWT, bcrypt, requireAuth middleware
│   ├── storage.ts               # Database interface (Drizzle)
│   ├── db.ts                    # Drizzle client
│   ├── oddsService.ts           # The Odds API integration
│   ├── parlayService.ts         # Parlay correlation engine
│   ├── stripeService.ts         # Stripe checkout + subscription sync
│   ├── stripeClient.ts          # Stripe SDK client
│   └── webhookHandlers.ts       # Stripe webhook event handlers
├── shared/
│   ├── schema.ts                # Drizzle schema + Zod types (shared)
│   └── routes.ts                # API route constants (shared)
├── PRD.md                       # Full product requirements (including MLB plan)
├── README.md                    # This file
└── replit.md                    # Architecture notes for Replit agent
```

---

## Getting Started (Development)

The project runs automatically on Replit via the `Start application` workflow (`npm run dev`).

For local development:
```bash
npm install
npm run dev
```

Server starts on port 5000. Frontend is served by Vite through the same Express process.

---

## Environment Variables

Set these in Replit's Secrets panel:

| Variable | Required | Description |
|----------|----------|-------------|
| `ADMIN_EMAIL` | Yes | Email address for the admin account |
| `SESSION_SECRET` | Yes | Express session signing secret |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `ODDS_API_KEY` | Recommended | The Odds API key (20K plan = $30/mo) |
| `STRIPE_SECRET_KEY` | Yes (payments) | Stripe secret key |
| `VITE_STRIPE_PUBLISHABLE_KEY` | Yes (payments) | Stripe publishable key (frontend) |

---

## Authentication

- Users register/login with email + password (bcrypt hashed, 10 rounds)
- On login: server returns a signed JWT alongside the session cookie
- Frontend stores JWT in `localStorage` as `ll_auth_token`
- Every API request sends `Authorization: Bearer <token>` header
- Server accepts **either** Bearer token or session cookie — whichever is present
- This dual approach makes auth work on mobile, in iframes, and across cross-origin contexts where cookies may be blocked

### Admin Setup
1. Set `ADMIN_EMAIL` environment variable to your email
2. Register an account with exactly that email
3. The account gets `isAdmin = true` and unlimited access forever

---

## Subscription Tiers

| Tier | Price | Access |
|------|-------|--------|
| Free | $0 | 10 probability calculations total |
| NBA Only | $25/mo | Unlimited NBA calculations |
| All Sports | $50/mo | Unlimited NBA + MLB (when launched) |
| Admin | — | Everything, unlimited |

Stripe products: "NBA Only – LiveLocks" and "All Sports – LiveLocks"  
To initialize: Admin panel → Setup Stripe Products button

---

## Key API Endpoints

### Auth
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth/register` | Create account, returns JWT |
| `POST` | `/api/auth/login` | Login, returns JWT |
| `POST` | `/api/auth/logout` | Clear session |
| `GET` | `/api/auth/me` | Current user (JWT or cookie) |

### NBA Calculator
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/calculate` | Run probability calculation (gated) |
| `POST` | `/api/parlay/calculate` | Calculate parlay with correlation |
| `GET` | `/api/live-games` | ESPN NBA scoreboard (30s cache) |
| `GET` | `/api/live-stats/:gameId` | Live box score for a game |
| `GET` | `/api/odds` | Player prop lines from The Odds API |
| `GET` | `/api/game-lines` | Game spread and total |
| `GET` | `/api/injuries` | NBA injury report |
| `GET` | `/api/halftime-plays` | Best plays at halftime |
| `POST` | `/api/sync-rosters` | Trigger player stat sync |

### Admin
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/admin/users` | All users |
| `PATCH` | `/api/admin/users/:id/tier` | Set subscription tier |
| `PATCH` | `/api/admin/users/:id/reset-plays` | Reset play count |
| `GET` | `/api/admin/feedback` | User feedback inbox |

### Stripe
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/stripe/checkout` | Create checkout session |
| `POST` | `/api/stripe/setup-products` | Initialize Stripe products (admin) |
| `POST` | `/api/webhooks/stripe` | Stripe webhook handler |

---

## Probability Model (NBA)

The calculator uses a blended rate approach:

1. **Blended per-minute rate**: `observedRate × 0.7 + seasonBaseline × 0.3`
2. **Foul penalty**: 3 fouls = 30% minute reduction; 4+ fouls = 55% reduction
3. **Remaining minutes**: projected from current period + game clock
4. **Expected total**: `currentStat + (projectedMinutes × blendedRate)`
5. **Defense adjustment**: opponent `defRating` (0.88–1.12 scale) applied to expected total
6. **Pace adjustment**: blends team historical pace with live game pace (score-based)
7. **Probability**: `50 + difference × scaleFactor` (clamped 2–98%)

Scale factors (usage-adjusted): points=8, rebounds/assists=10, steals/blocks=15, combos=6

---

## Data Sources

| Source | Data | Refresh |
|--------|------|---------|
| ESPN API | Live scores, box scores, injuries | 30s |
| The Odds API | Sportsbook prop lines (DK, FD, HR) | 5 min cache |
| NBA.com stats | Season per-game averages, H2 splits | Daily |
| NBaStuffer | Fallback season stats | Daily |

---

## Mobile UX

- **Header**: On screens < 640px, hides Sync Rosters, live game counter, plays badge, and subscription badge. Only shows logo and Parlay Slip button.
- **Parlay Slip**: On screens < 1024px, opens as a fixed bottom sheet overlay. Desktop shows a side column.
- **Auth**: JWT in localStorage means auth works in mobile browsers, Replit preview iframe, and across cross-origin contexts — not reliant on cookies.

---

## Checkpoints

| Checkpoint | Description |
|-----------|-------------|
| `b9f431cd22f951b4f7aef34657876ee01dcdc336` | **Stable NBA baseline** — all features working, mobile-optimized, pre-MLB |

To roll back to any checkpoint, open the Replit chat and ask to revert to that commit ID.

---

## Planned: MLB Baseball Expansion

See `PRD.md` for the full product requirements document covering:
- Supported prop types: Hits, Total Bases, Strikeouts, Home Runs
- Data sources: Baseball Savant, MLB.com/ESPN, Open-Meteo weather
- Probability engine with weather adjustments and pitcher matchup factors
- Live box score display with exit velocity and launch angle
- Pitcher card: pitch count, last pitch type, avg velocity
- Implementation order and rollback plan
