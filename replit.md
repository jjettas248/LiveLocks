# LiveLocks by PropPulse — NBA/NCAAB Live Lines

## Overview
A full-stack NBA + NCAAB live betting analytics PWA. Calculates probability of a player hitting a live prop line at halftime, shows NCAAB live spread/total/team-total probabilities, and lets users build correlation-adjusted parlays. Real live game data from ESPN + The Odds API + Sports Game Odds (SGO). Stripe subscriptions, SMS/push alerts, admin panel.

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
- **Pro – LiveLocks** → tier `"all"` → $40/mo → `price_1T6fl12cW8Vmrgt3B6ffBIuw`
- **All Sports – LiveLocks** → tier `"elite"` → $65/mo → `price_1T6fly2cW8Vmrgt3WU9uHL7L`
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
- `users` — id, email, passwordHash, isAdmin, subscriptionTier, playsUsed, stripeCustomerId, stripeSubscriptionId, pushSubscription, pushAlerts, phoneNumber, smsAlerts, smsConsent, **isNewProUser**, **requiresRefresh**, **upgradedAt**
- `feedback` — id, userId (nullable FK → users), message, createdAt
- `stripe.*` — managed by stripe-replit-sync

## NCAAB Engine (server/ncaabService.ts)

### Data Sources
1. **ESPN Scoreboard** — `?limit=300&groups=50` all Div I live games + box scores
2. **The Odds API** — spread/total book lines + American odds
3. **Sports Game Odds (SGO)** — 1H lines + team total lines per team

### Probability Formula
`overProb = clamp(50 + (projectedTotal - line) × multiplier × 0.3, 1, 99)`

- `getDynamicMultiplier(secsRemaining, 2400, period, 2)` — steps from 3.0 (early) → 12.0 (late/OT)
- `getH1Multiplier(h1Progress)` — same step table for H1-specific market
- `sanitizeProb(prob, secsElapsed)` — returns 50 if < 60s elapsed (no data guard)

### Post-halftime H1 settlement
After halftime (half === 2 or isHalftime), `over1HProb` is set to 99/1 based on actual H1 total vs the H1 line.

### isNeutralState (frontend)
`gameProgress < 10%` AND raw engine prob within [45, 55] → shows "--" gauge, "EARLY GAME" label, "Insufficient Data" verdict, "--" market percentages.

### progressive prob limits (frontend)
`limitedEngineProb(rawProb, gameProgress)` — clamps to narrowing range as game progresses:
- < 10%: [30, 70]; < 25%: [20, 80]; < 50%: [10, 90]; < 75%: [5, 95]; < 90%: [3, 97]; else: [1, 99]

### NCAABPlay Fields (key)
- `homeGameTotalLine`, `awayGameTotalLine` — from SGO team total odds (Priority 1)
- `homeGameTotalIsEstimated`, `awayGameTotalIsEstimated` — true when SGO + ESPN both null → derived from proj
- `home1HTotalLine`, `away1HTotalLine` — SGO 1H team total lines
- `h1TotalLine` — SGO 1H total line (whole game)
- `homeProjected`, `awayProjected` — projected final score per team
- `half`, `period`, `clock` — live game state

## NCAAB Game Card Features

### Market Buttons
Three primary buttons: Over / Under / Spread. Clicking selects the market and updates:
- RadialGauge (teal/red arc showing engine probability)
- EV verdict row: "Strong/Lean [Side] EV" or "Neutral — No Edge"
- CLV row: "↑ Over" / "↓ Under" / "Even"
- +Xpp amber pill when edge ≥ 5pp

### Team Total Market (in progress — next build session)
- Over/Under team-total buttons embedded in proj rows (rows 4/5 of stat grid)
- `selectedTeamMarket` state drives a second verdict section below game total verdicts
- Lines from SGO (book) or `deriveTeamTotalLine(proj)` (estimated, shown with "~")
- "Est." badge in divider header; confidence compressed 40% toward 50 when estimated

### H2H Matchup History
- **H2HSection** component: toggle row (ChevronDown animated) + animated slide-down rows
- **Dual badges per row**: O/U result (OVER/UNDER/PUSH/N/A) + spread coverage
- **Fetch**: current season first; if < 2 games → extend to prior season; deduplicate by event ID; max 3 rows
- **Season label**: prior-season rows show "[date] · Prior Season" in zinc-600 italic
- **Insufficient states**: 0 games = "No matchup history found", 1 game = note below row

### NCAABGamesStrip
- 160px horizontal scrollable chip bar above game list
- Chips show live scores / halftime / scheduled times
- Clicking a chip scrolls to and expands that game's card
- Always rendered above `GroupedGamesList` — not nested inside same container

## Welcome Experience (New Pro Users)
- `isNewProUser`, `requiresRefresh`, `upgradedAt` columns on `users` table
- Set by Stripe webhook on `checkout.session.completed` and admin tier change
- **WelcomeBanner**: spring-in animated card; contextual subtitle (# live games / halftime / scheduled); "Explore →" button triggers tab switch + scroll to first live game; "Dismiss" clears flag via `POST /api/user/clear-new-pro-flag`
- **NEW badge**: teal animated badge on NCAAB tab button, visible for 24h from `upgradedAt`; 30-min interval re-check
- **`expandToGameId`** prop on NCAABAdminTab: `useEffect` expands target card and scrolls to it

## Admin Panel (/admin)
- View all users, change subscription tier, reset play counts, read feedback
- Change tier: `null` → `"all"` → `"elite"` (no `"nba"` tier)
- Tier changes via Stripe API (create/update subscription) or direct DB write if no Stripe customer

## NCAAB H2H API
- `getNCAABH2H(gameId)` — ESPN team schedule endpoint, dual-season fetch, cached per gameId
- `/api/ncaab/h2h?gameId=X` → `{ games: H2HGame[] }` (requireAdmin)
- `H2HGame` fields: `date`, `location`, `awayScore`, `homeScore`, `total`, `spread`, `spreadTeam`, `awayAbbr`, `homeAbbr`, `awayTeam`, `homeTeam`, `isCurrent`

## NBA Roster Sync
- `POST /api/sync-rosters` — pulls live ESPN rosters, maps team abbreviations via `ESPN_TO_DB`
- Key abbr fixes: `UTH → UTA`, `UTAH → UTA`, `GS → GSW`, `PHO → PHX`, `WSH → WAS`, `CHO → CHA`
- Position mapping: ESPN `G → SG`, `F → SF`, `FC → PF`, `GF → SF`

## Parlay Builder
- `ParlayPickInput` fields: `playerId`, `playerName`, `playerTeam`, `statType`, `line`, `probability`, `betDirection`, `sportsbook`, `oddsAmerican`, `gameId?`, `isEstimated?`
- NCAAB stat types: `ncaab_total`, `ncaab_1h_total`, `ncaab_spread`, `ncaab_team_total`
- `parlay-slip.tsx` renders each leg with name, stat badge, sportsbook, probability; estimated legs show amber "Est." pill with tooltip

## Mobile UX
- JWT works everywhere (mobile, iframes, cross-origin)
- Parlay Slip: bottom sheet on mobile (< 1024px), side column on desktop

## Required Environment Variables
- `ADMIN_EMAIL` — Admin account email
- `ODDS_API_KEY` — The Odds API key
- `SGO_API_KEY` — Sports Game Odds API key (team totals, 1H lines)
- `STRIPE_SECRET_KEY` — Stripe secret key
- `VITE_STRIPE_PUBLISHABLE_KEY` — Stripe publishable key
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` — SMS alerts
- `SESSION_SECRET`, `DATABASE_URL` — already set

## NBA Probability Model (Players)
1. Derive per-minute rate from halftime observed stats (70%) + season baseline (30%)
2. Project remaining minutes after foul penalty
3. Multiply by defense rating (opponent vs player's position)
4. Multiply by blended pace multiplier
5. `probability = 50 + difference × scaleFactor` (clamped 2–98%)

## 2025-26 Roster Notes (Key Trades)
- Luka Doncic → LAL; Anthony Davis → DAL
- De'Aaron Fox → SAS; Jimmy Butler → GSW
- Domantas Sabonis → MIL; Cooper Flagg (2025 #1 pick) → NOP

## Debug Notes
- TypeScript strict mode: always use `Array.from()` for Set/Map iteration instead of `[...spread]`
- `bellRef` is typed `SVGSVGElement` — cast to `HTMLElement` for `.offsetWidth` DOM reflow trick
- `stripeService.ts` tier key is `"all" | "elite"` (never `"nba"`)
- `onExpandGame` prop on GroupedGamesList expects `(id: string | null) => void`
