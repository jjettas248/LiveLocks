# LiveLocks by PropPulse — NBA Live Lines

## Overview
A full-stack NBA live betting tool that calculates the probability of a player hitting a live prop line at halftime. It pulls real live game data, player box scores, sportsbook odds, and lets users build correlation-adjusted parlays with deeplinks to DraftKings, FanDuel, and Hard Rock Bet.

## Architecture
- **Frontend**: React + Vite, Tailwind CSS, shadcn/ui, TanStack Query, react-hook-form, wouter
- **Backend**: Express.js (TypeScript, tsx)
- **Database**: PostgreSQL via Drizzle ORM
- **Shared types**: `shared/schema.ts` and `shared/routes.ts`

## Key Features
- **196 players** across all 30 NBA teams (2025-26 rosters with all major trades), grouped by team
- **10 stat types**: Points, Rebounds, Assists, Steals, Blocks, and 5 combo props (PRA, PR, PA, RA, S+B)
- **Live game strip**: ESPN scoreboard auto-refreshes every 30s; clicking a game selects it and filters players to that matchup
- **Live box score panel**: Full clickable box score table appears when a game is selected — click any row to instantly auto-fill minutes, fouls, and current stat (sorted by selected prop type, grouped by team, players with minutes > 0 only)
- **Auto-fill visual feedback**: Green-highlighted inputs show which fields were populated from live stats; each field clears the highlight if manually edited
- **Improved name matching**: Uses first-initial + last-name matching (fallback from exact match) for more reliable ESPN→DB player resolution
- **Parlay auto-calculate**: Parlay result updates automatically (debounced 300ms) whenever picks change — no manual button press needed
- **Sportsbook odds**: The Odds API integration for DraftKings, FanDuel, Hard Rock (5-min cache); gracefully degrades without key
- **Probability engine**: Blends observed halftime per-minute rate (70%) with season baseline (30%), usage-adjusted scale factor
- **Foul trouble penalty**: 3 fouls = 30% minute reduction, 4+ fouls = 55% reduction
- **Parlay builder**: Up to 10 picks, correlation-adjusted combined probability ring, implied American odds
- **Correlation engine**: Same-team pts vs pts = -8%, assists+points teammate = +8%, same-game diff teams = +4%
- **Sportsbook deeplinks**: Open DK/FanDuel/Hard Rock bet slip pages (user confirms the bet themselves)
- **Season stats sync**: `/api/sync-stats` uses BallDontLie API (requires BDL_API_KEY) to populate ppg/rpg/apg/spg/bpg/usageRate

## Database Tables
- `players` — id, name, team (3-letter abbr), position, avgMinutes, avgFouls, ppg, rpg, apg, spg, bpg, usageRate, statsUpdatedAt
- `team_defense` — id, teamName, position, defRating (0.88–1.12 scale, 1.0 = league avg)
- `parlayPicks` — id, sessionId, playerId, statType, line, sportsbook, probability, oddsAmerican, addedAt

## API Routes
- `GET /api/players` — all players sorted alphabetically
- `GET /api/teams` — distinct team abbreviations
- `POST /api/calculate` — main probability calculation
- `GET /api/live-games` — ESPN live NBA scoreboard proxy (30s cache)
- `GET /api/live-stats/:gameId` — ESPN player box score for a live game
- `GET /api/odds?gameId=&playerName=&statType=` — The Odds API proxy (5-min cache)
- `POST /api/parlay/calculate` — correlation-adjusted parlay probability
- `GET /api/sync-stats` — BallDontLie season stats sync (requires BDL_API_KEY env var)

## Authentication & Subscriptions
- Users register/login with email + password (bcrypt hashed)
- **Play gating**: Free users get 10 total probability calculations. After 10, a paywall modal appears.
- **Admin**: Set `ADMIN_EMAIL` env var before registering. The account with that email gets `isAdmin=true` and unlimited access.
- **Stripe subscriptions**: 3 tiers — NBA Pro ($29/mo), All Sports ($59/mo), Elite ($79/mo + SMS alerts)
- Subscription tier stored in `users.subscriptionTier` (null = free, 'nba' = NBA Pro, 'all' = All Sports, 'elite' = Elite)
- Stripe products seeded via `npx tsx scripts/seed-stripe-products.ts` (already run)
- Stripe integration via Replit connector (stripe-replit-sync keeps local DB in sync via webhooks)
- Elite tier unlocks all "all" features + SMS alerts via Twilio

### Admin Setup Flow
1. Set `ADMIN_EMAIL` environment variable to your email address
2. Register an account with that exact email address
3. The account will have `isAdmin=true` and unlimited play access

### Stripe Setup
- Products already created: "NBA Only – LiveLocks" ($25/mo) and "All Sports – LiveLocks" ($50/mo)
- Webhook endpoint: `POST /api/stripe/webhook` (registered before express.json middleware)
- Checkout endpoint: `POST /api/stripe/checkout` with body `{ tier: "nba" | "all" }`
- On payment success: user redirected to `/?payment=success&tier={tier}`

### Stripe Checkout Appearance
Two things appear in the Stripe checkout header that may need updating:

1. **"Sandbox" badge** — This is Stripe's automatic test-mode indicator. It cannot be removed via code. It disappears automatically when you switch to live API keys in production. No action needed during development.

2. **Business name ("Nba Probability Engine")** — This is your Stripe account's business name. To change it to "LiveLocks":
   - Go to Stripe Dashboard → Settings → Business details
   - Update the Business name field to "LiveLocks"
   - Save changes — it will reflect immediately on the checkout page

## Database Tables
- `players` — id, name, team, position, avgMinutes, avgFouls, ppg, rpg, apg, spg, bpg, usageRate, statsUpdatedAt
- `team_defense` — id, teamName, position, defRating
- `users` — id, email, passwordHash, isAdmin, subscriptionTier, playsUsed, stripeCustomerId, stripeSubscriptionId
- `feedback` — id, userId (nullable FK → users), message, createdAt
- `stripe.*` — managed automatically by stripe-replit-sync (products, prices, customers, subscriptions)

## Admin Panel (/admin)
- Only accessible to `isAdmin=true` accounts
- View all users: email, join date, subscription tier, plays used
- Change any user's tier directly (bypass Stripe): Free → NBA → All Sports
- Reset a user's play count to 0 (for beta testers who hit the limit)
- Read all user feedback submissions
- Admin link appears in dashboard header for admin accounts

## Mobile UX
- **JWT auth**: Login/register responses include a signed JWT `token` field. Frontend stores it in `localStorage` under key `ll_auth_token` and sends it as `Authorization: Bearer <token>` on every request. Server accepts both Bearer token AND session cookie. This makes auth work everywhere — mobile browsers, iframes, cross-origin contexts — without any cookie restrictions.
- **Header (mobile)**: Live game counter, Sync Rosters button, plays remaining badge, and subscription badge are hidden on screens narrower than `sm` (640px). Parlay Slip button shows just the trophy icon without text. This keeps the header clean on phones.
- **Parlay Slip (mobile)**: On screens narrower than 1024px (`lg` breakpoint), the parlay slip opens as a fixed bottom sheet overlay instead of a side column. Tap the backdrop or the X button to close. On desktop it remains a side column.

## User Feedback
- Floating feedback button (bottom-right) visible to all logged-in users
- Submissions stored in `feedback` table; viewable in admin panel

## Required Environment Variables
- `ADMIN_EMAIL` — Email address that receives admin/unlimited access upon registration
- `ODDS_API_KEY` — The Odds API key (see below for upgrade path). App works without it (odds panel hidden)
- `BDL_API_KEY` — BallDontLie API key (for season stats sync). Not required for core functionality
- `SESSION_SECRET` — Express session secret (already set)
- `DATABASE_URL` — PostgreSQL connection string (already set)

## The Odds API — Upgrade Path
Current free tier: **500 credits/month** (exhausted). Each player prop line call = 1 credit.

At 50 users with 5-min server cache, expected usage: **2,000–5,000 credits/month**.

### Recommended next tier: 20K Plan ($30/month)
- 20,000 credits/month — covers up to ~200 active users comfortably
- Upgrade: log in at the-odds-api.com → Billing → select 20K plan
- The same API key continues to work; quota resets automatically
- No code changes needed — just upgrade the plan and add credits

### Future: Developer Plan ($59/month)
- 100,000 credits/month — appropriate for 500+ active users
- Only needed once the 20K tier is consistently hitting limits

## Probability Model
1. Derive per-minute rate from halftime observed stats (70%) + season baseline (30%)
2. Project remaining minutes after foul penalty
3. Multiply by defense rating (opponent vs player's position)
4. Multiply by blended pace multiplier (team historical pace + live game pace from score)
5. `probability = 50 + difference × scaleFactor` (clamped 2–98%)
6. Scale factor by stat (usage-adjusted): pts=8, reb/ast=10, stl/blk=15, combos=6; clamped 4–20

## 2025-26 Roster Notes (Key Trades)
- Luka Doncic → LAL; Anthony Davis → DAL
- De'Aaron Fox → SAS; Jimmy Butler → GSW
- Domantas Sabonis → MIL; Cooper Flagg (2025 #1 pick) → NOP
