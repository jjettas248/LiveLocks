# LiveLocks by PropPulse — NBA/NCAAB Live Lines

## Overview
A full-stack NBA + NCAAB live betting analytics tool. Calculates the probability of a player hitting a live prop line at halftime, shows NCAAB live spread/total probabilities, and lets users build correlation-adjusted parlays. Real live game data, player box scores, sportsbook odds.

## Architecture
- **Frontend**: React + Vite, Tailwind CSS, shadcn/ui, TanStack Query, react-hook-form, wouter
- **Backend**: Express.js (TypeScript, tsx)
- **Database**: PostgreSQL via Drizzle ORM
- **Shared types**: `shared/schema.ts` and `shared/routes.ts`

## Tab Structure
```
Top tab bar:  [🏀 NBA Live]  [🏀 NCAAB Live]*  [⚾ MLB Live 🔒]

When NBA Live active, sub-tabs appear:
              [Live Props]  [2H Plays]

When NCAAB Live active, sub-tabs appear:
              [Live]  [2H Plays]
```
*NCAAB only visible to Pro/All Sports/Admin users

## Tier Structure (2 paid tiers)

| Feature | Free | Pro ($40/mo) | All Sports ($65/mo) |
|---------|------|------------|------------------|
| NBA Live Props | 15 plays then paywall | unlimited | unlimited |
| NBA 2H Plays | locked | yes | yes |
| NCAAB Live + 2H | no | yes | yes |
| MLB Live | no | no | coming soon |
| Push Notifications | no | yes | yes |
| SMS Alerts | no | yes | yes (priority) |
| Parlay Builder | yes (with plays) | yes | yes |

- Internal tier keys: `null` = free, `"all"` = Pro, `"elite"` = All Sports
- **Admin**: jaylin.becker22@icloud.com / LiveLocks2026!
- Free play limit: **15 plays**

## Stripe Products
- **Pro – LiveLocks** → tier `"all"` → $40/mo
- **All Sports – LiveLocks** → tier `"elite"` → $65/mo
- Seeded via `npx tsx scripts/seed-stripe-products.ts`

## Authentication & Subscriptions
- JWT-based auth (Bearer token in localStorage `ll_auth_token`)
- Registration requires SMS consent checkbox (`smsConsent: boolean` in DB)
- Admin: `ADMIN_EMAIL` env var → unlimited access
- Stripe webhook: `POST /api/stripe/webhook`
- Checkout: `POST /api/stripe/checkout` with `{ tier: "all" | "elite" }`

### Access Control (Backend)
- `/api/calculate` — requires auth + play count check (`requirePlayAccess`)
- `/api/halftime-plays` — requires `requireTier("all","elite")`
- `/api/ncaab/plays`, `/api/ncaab/games` — requires `requireTier("all","elite")`
- `/api/user/alerts/sms` — requires `["all","elite"]` subscription
- `/api/webhooks/twilio` — no auth (Twilio STOP webhook)

### SMS Alerts (Twilio)
- Required env vars: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`
- `POST /api/webhooks/twilio` — handles STOP/UNSUBSCRIBE/CANCEL/END/QUIT → sets smsAlerts=false + smsConsent=false; always returns `<Response></Response>` XML
- Available to Pro (`all`) and All Sports (`elite`) subscribers
- `server/twilioService.ts` wraps the Twilio SDK
- Gracefully degrades if env vars missing

## Database Tables
- `players` — id, name, team (3-letter abbr), position, avgMinutes, avgFouls, ppg, rpg, apg, spg, bpg, usageRate, statsUpdatedAt, h2ppg, h2rpg, h2apg, h2spg, h2bpg, h2tpg, h2avgMinutes
- `team_defense` — id, teamName, position, defRating
- `users` — id, email, passwordHash, isAdmin, subscriptionTier, playsUsed, stripeCustomerId, stripeSubscriptionId, pushSubscription, pushAlerts, phoneNumber, smsAlerts, smsConsent
- `feedback` — id, userId (nullable FK → users), message, createdAt
- `stripe.*` — managed by stripe-replit-sync

## NCAAB Service
- `server/ncaabService.ts` — ESPN scoreboard (`?limit=300&groups=50` = all Div I games) + box scores + The Odds API
- Auto-refreshes every 60s; shows spread/total/team-total probabilities
- 2H Plays sub-tab filters plays where `bettingWindow === "HALFTIME"`

## Admin Panel (/admin)
- View all users, change subscription tier, reset play counts, read feedback
- Change tier: `null` → `"all"` → `"elite"` (no `"nba"` tier any more)

## NBA Roster Sync
- `POST /api/sync-rosters` — pulls live ESPN rosters, maps team abbreviations via `ESPN_TO_DB`
- Key abbr fixes: `UTH → UTA`, `UTAH → UTA`, `GS → GSW`, `PHO → PHX`, `WSH → WAS`, `CHO → CHA`
- Position mapping: ESPN `G → SG`, `F → SF`, `FC → PF`, `GF → SF`

## Mobile UX
- JWT works everywhere (mobile, iframes, cross-origin)
- Parlay Slip: bottom sheet on mobile (<1024px), side column on desktop

## Required Environment Variables
- `ADMIN_EMAIL` — Admin account email
- `ODDS_API_KEY` — The Odds API key
- `STRIPE_SECRET_KEY` — Stripe secret key
- `VITE_STRIPE_PUBLISHABLE_KEY` — Stripe publishable key
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` — SMS alerts
- `SESSION_SECRET`, `DATABASE_URL` — already set

## Probability Model
1. Derive per-minute rate from halftime observed stats (70%) + season baseline (30%)
2. Project remaining minutes after foul penalty
3. Multiply by defense rating (opponent vs player's position)
4. Multiply by blended pace multiplier
5. `probability = 50 + difference × scaleFactor` (clamped 2–98%)

## 2025-26 Roster Notes (Key Trades)
- Luka Doncic → LAL; Anthony Davis → DAL
- De'Aaron Fox → SAS; Jimmy Butler → GSW
- Domantas Sabonis → MIL; Cooper Flagg (2025 #1 pick) → NOP
