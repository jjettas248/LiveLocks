# LiveLocks by PropPulse — Product Requirements Document

**Version**: 3.0
**Last Updated**: March 2026
**Status**: Active — NBA + NCAAB Live, MLB Planned

---

## 1. Product Overview

LiveLocks by PropPulse is a real-time sports betting analytics platform for serious NBA and NCAAB bettors. It surfaces live in-game probability models, 2nd-half play recommendations, and NCAAB full-slate coverage — delivered as a PWA with push notifications and SMS alerts.

### Vision

Give serious sports bettors a data edge through live statistical modeling they cannot get from sportsbooks or public analytics tools, fast enough to act on during live games.

### Core Value Proposition

- **Live prop calculator**: Real-time player prop probability updated as the game progresses, for any quarter (Q1–Q4)
- **Live box score edge detection**: Automatic row/cell color-coding when the engine finds an edge on any player's book line — no manual input required
- **2H Plays**: Halftime engine recalculates full-game prop projections for all live halftime games simultaneously, surfaces top plays sorted by confidence
- **Full NCAAB slate**: All Division I games covered daily with 2H spread/total/team-total projections
- **Multi-channel alerts**: Web push and SMS for high-confidence plays and new halftime triggers

---

## 2. Users and Access Tiers

### 2.1 User Roles

| Role | Access |
|------|--------|
| Guest (not logged in) | Registration and login pages only |
| Free (registered, no subscription) | 15 live NBA prop calculations, then paywall |
| Pro | Unlimited NBA + NCAAB live + 2H Plays + Push + SMS |
| All Sports | Everything in Pro + MLB Live (coming soon) + Priority SMS |
| Admin | Full access to all features + admin panel + no limits |

**Admin account**: Set via `ADMIN_EMAIL` environment variable at registration time.

### 2.2 Subscription Tiers

| Feature | Free | Pro ($40/mo) | All Sports ($65/mo) |
|---------|------|-------------|-------------------|
| NBA Live Props | 15 plays then paywall | Unlimited | Unlimited |
| Live Box Score Edge Signals | No | Yes | Yes |
| NBA 2H Plays | Teaser view (blurred) | Yes | Yes |
| NCAAB Live | No | Yes | Yes |
| NCAAB 2H Plays | No | Yes | Yes |
| MLB Live | No | No | Coming Soon |
| Push Notifications | No | Yes | Yes |
| SMS Alerts | No | Yes | Yes (Priority) |
| Parlay Builder | Yes (within play limit) | Yes | Yes |

**Internal tier keys**: `"all"` = Pro, `"elite"` = All Sports, `null` = Free

### 2.3 Free Play Limit

Free users may perform **15 live prop calculations** before hitting the upgrade paywall. The counter increments on each successful server-side calculate response. Admin and paid users bypass the counter. Errors do not consume plays.

---

## 3. Navigation and Tab Structure

```
Top navigation bar:
  [NBA Live]  [NCAAB Live]  [MLB Live 🔒]

When NBA Live is active — sub-tab pill row appears below:
  [Live Props]  [2H Plays]

When NCAAB Live is active — sub-tab pill row appears below:
  [Live]  [2H Plays]
```

**Visibility rules**:
- **NBA Live**: visible to all logged-in users
- **NCAAB Live**: visible to Pro, All Sports, and Admin users; hidden from free users
- **MLB Live**: visible to all users with a lock indicator; clicking opens a "coming soon" popover

---

## 4. Feature Specifications

### 4.1 NBA Live Box Score

The box score panel opens when the user selects a live game from the game strip.

**Display columns** (configurable via dropdown):
- MIN, PTS, REB, AST, STL, BLK, FGM-FGA, FTM-FTA, 3PM-3PA, PF
- One "watched" stat column (PTS, REB, AST, PRA, etc.) selected by the user — highlighted in the header

**Live edge signals** (automatic, no user input required):
- On load and every 90 seconds, the server runs `/api/live-signals/:gameId`
- For each player with ≥3 minutes played, checks 5 primary markets: Points, Rebounds, Assists, Threes, PRA
- Fetches real book lines from The Odds API (live → pre-game fallback) then SGO; never fabricates a line
- Runs the probability engine with the actual current period and clock
- Only returns signals where edge ≥5% from 50%

**Color tier thresholds**:

| Color | Condition |
|-------|-----------|
| Green (#22c55e) | Hit implied ≥85% OVER direction |
| Red (#ef4444) | Hit implied ≥85% UNDER direction |
| Yellow (#eab308) | Hit implied 70–84% either direction |
| Teal (#00d4aa) | Hit implied 60–69% either direction |

**Two-level color mapping**:
- **Row highlight**: driven by the player's best signal across any prop type
- **Watched stat cell**: driven by the signal for the currently selected stat column only
- Switching the column dropdown instantly remaps cell colors — no additional network request

**Filter + click-to-fill**:
- Text filter box narrows visible player rows
- Clicking any player row auto-fills the calculator panel (player, opponent, period, clock, current stat value)

### 4.2 NBA Live Props Calculator

**Inputs**:
- Player name (searchable dropdown, synced from ESPN roster)
- Stat type: Points / Rebounds / Assists / 3-Pointers Made / Steals / Blocks / Pts+Reb+Ast / Pts+Reb / Pts+Ast / Reb+Ast / Stl+Blk
- Current stat value
- Prop line (from sportsbook — auto-fetched from The Odds API when player + stat type are selected)
- Game clock remaining (minutes)
- Period (Q1–Q4 / OT)
- Optional: game total line, halftime score, game spread

**Auto-fill from box score**: Clicking a player row in the box score populates all calculator fields automatically.

**Auto-fetch odds**: When player + stat type are selected, the odds panel queries The Odds API and displays per-book lines. User can set the line manually or use the fetched median.

**Output**:
- Probability gauge (circular ring), labeled percentage
- Hit Implied percentage
- Over/Under call label
- Edge vs. book-implied odds
- "Add to Parlay" button

**Probability threshold for high-confidence alert**: `|prob - 50| ≥ 35` (equivalent to ≥85% hit implied)

### 4.3 NBA 2H Plays

Appears as a sub-tab under NBA Live (labeled "2H Plays"). Fetches all live NBA games at halftime, then for each game:

1. Fetches ESPN box score summary
2. For each player with ≥3 minutes at halftime, checks all 11 stat type combinations
3. Looks up book lines (Odds API live → pre-game → SGO) — skips if no real line found
4. Uses median consensus line across all available books
5. Runs probability engine with `currentPeriod: 3, gameClock: "12:00"` (start of 2H)
6. Skips plays where the line has already been cleared at halftime (not actionable)
7. Returns top 20 plays sorted by edge descending

**Display**: Play cards grouped by game. Each card shows:
- Player name + stat type
- "H1: {halftimeStat} — Needs {remainder} more" status line
- Season average and projected minutes
- Primary call box: OVER/UNDER/MONITOR with confidence %
- Engine % vs. book-implied % comparison bars
- Betting % bar (action split)
- "Add to Parlay" button

**Alert trigger**: Plays with edge ≥35 (≥85% hit implied) fire a push notification and/or SMS on first detection per player/stat/line per session.

**Locking for free users**: Free users see one teaser card; remaining plays are blurred with an upgrade prompt overlay.

### 4.4 NCAAB Live

Available to Pro, All Sports, and Admin users.

**Game strip**: Horizontal scrollable chip bar showing all live and scheduled NCAAB games. Clicking a chip scrolls to that game's card and highlights it.

**Game cards** display:
- Team names, current score, period/clock
- Market buttons: Spread, Total, H1 Total, H1 Spread
- Radial probability gauges for each market
- EV verdict label (Strong Over / Slight Under / etc.)
- CLV indicator (Closing Line Value signal)
- Live win probability (based on score differential and pace)
- H2H matchup history toggle
- "Add to Slip" buttons for parlay builder

**Data sources**: ESPN (live scores) + The Odds API (all available bookmakers, no restriction) + SGO (1H lines, team totals fallback).

**NCAAB 2H Engine**:
- Runs for games at halftime with real book lines
- Computes 2H spread, 2H total, and team totals
- Shows "Engine: X%" vs "Book: Y%" comparison
- H2 projection display: `{H1 score} + ~{projected H2} = {projected final}` format
- Alert deduplication: one alert per gameId per calendar day via in-memory set

### 4.5 MLB Live

Placeholder tab visible to all users. Clicking shows:
- Free users: "Coming soon" popover with upgrade prompt
- Pro/All Sports: "Coming soon for All Sports subscribers" message
- All Sports: "Coming soon" with feature preview

No live data until MLB season integration is built.

### 4.6 Parlay Builder

**Activation**: "Add to Parlay" buttons appear below each prop and on NCAAB game cards.

**Functionality**:
- Running slip of added plays showing combined odds and correlation-adjusted probability
- On mobile: fixed bottom sheet with handle to expand
- On desktop: side column panel
- Correlation adjustments: same-game parlays are discounted for known correlations (e.g. points and PRA from the same player)
- Deeplinks: DraftKings, FanDuel, Hard Rock, Bet365 — picks copied to clipboard on click

---

## 5. Registration and Authentication

### 5.1 Registration Form

Required:
- **Email** — unique per account
- **Password** — minimum 8 characters
- **SMS Consent checkbox** — required; cannot submit without checking

Optional:
- **Phone Number** — US number in any common format; normalized to E.164 (`+1XXXXXXXXXX`) on save

On submission with SMS consent checked:
- `smsConsent = true` stored in DB
- `smsAlerts = true` stored in DB (auto-opted in)
- Phone number stored if provided

### 5.2 Login

Accepts either:
- **Email** + password
- **Phone number** (any common format) + password — looked up via `phone_number` column

### 5.3 JWT Authentication

- 30-day token expiry
- Stored in localStorage as `ll_auth_token`
- Sent as `Authorization: Bearer <token>` header on every request
- Session cookie maintained as fallback
- Either method is accepted server-side

### 5.4 Admin Account

Identified by matching `ADMIN_EMAIL` env variable at registration. Admin bypasses all tier gates and play limits.

---

## 6. Alerts System

### 6.1 Onboarding Modal

After first login, all users see an "Enable Alerts" modal:
- Push notifications option (visible to all)
- SMS option (visible to Pro/All Sports/Admin only)
- Prompt to add phone number if not yet set
- Dismissed state stored in `localStorage` (`ll_alerts_onboarded`)

### 6.2 Alert Triggers

| Trigger | Threshold | Deduplication |
|---------|-----------|---------------|
| NBA high-confidence play | ≥85% hit implied (`edge ≥ 35`) | Per `playerName|statType|line` per session |
| NCAAB halftime play | ≥85% hit implied | Per `gameId` per calendar day |
| New halftime game detected | Any game enters halftime | Per `gameId` per session |

### 6.3 Push Notifications

- Available to Pro and All Sports subscribers
- User opts in via the Alerts panel (bell icon in dashboard header)
- Uses Web Push API (VAPID keys configured via environment variables)
- Payload: title + body + URL back to dashboard
- Stored as serialized push subscription in DB

### 6.4 SMS Alerts

- Available to Pro and All Sports subscribers
- Auto-opted in at registration when consent checkbox is checked
- Phone stored in E.164 format
- Delivered via Twilio using `TWILIO_FROM_NUMBER`

**Opt-out**: Twilio STOP webhook at `POST /api/webhooks/twilio` — any inbound STOP/UNSUBSCRIBE/CANCEL/END/QUIT sets `smsAlerts = false` and `smsConsent = false` for that user.

### 6.5 SMS Compliance

- Consent checkbox required at registration
- Consent language: "I explicitly consent to receive SMS text alerts and account notifications from LiveLocks AI. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out."
- Consent stored as boolean in DB (`sms_consent` column)
- STOP keyword processing via Twilio webhook

---

## 7. Stripe Payments

### 7.1 Products

| Plan | Internal Key | Monthly Price |
|------|-------------|---------------|
| Pro | `all` | $40 |
| All Sports | `elite` | $65 |

### 7.2 Payment Flow

1. User clicks "Upgrade" → upgrade modal shows two plan cards
2. User selects plan → `POST /api/stripe/create-checkout-session` → redirected to Stripe-hosted checkout
3. On success → Stripe webhook `customer.subscription.created` → `subscriptionTier` set in DB
4. On cancel/failure → redirected back to dashboard with no tier change
5. Cancellation managed via Stripe billing portal (`POST /api/stripe/portal`)

### 7.3 Upgrade Modal

- **Pro ($40/mo)** — badge: "Best Value" — features: NBA Live Unlimited, NCAAB Live, NBA + NCAAB 2H Plays, Push + SMS Alerts
- **All Sports ($65/mo)** — badge: "Power Users" — features: everything in Pro + MLB Live (Coming Soon) + Priority SMS

---

## 8. Data Sources and Caching

| Source | Data | Cache TTL |
|--------|------|-----------|
| ESPN Scoreboard API | Live NBA/NCAAB scores | 30s |
| ESPN Summary API | Box score per game | 90s |
| ESPN Injuries API | NBA injury report | 5 min |
| The Odds API (live) | In-play prop lines | 90s |
| The Odds API (pre-game) | Pre-game prop lines | 5 min |
| The Odds API (NCAAB) | Spreads, totals, H1 lines | 5 min |
| Sports Game Odds (SGO) | NCAAB 1H/team-total lines | Rate-limited; 10-min backoff on 429 |
| NBA.com / ESPN Stats | Season per-game averages, H2 splits | Daily (sync on demand) |

### 8.1 ESPN Abbreviation Mapping

The following ESPN team abbreviations are remapped to internal DB abbreviations:

| ESPN | DB |
|------|----|
| GS | GSW |
| SA | SAS |
| NO | NOP |
| NY | NYK |
| PHO | PHX |
| UTH / UTAH | UTA |
| WSH | WAS |
| CHO | CHA |

### 8.2 Odds Line Methodology

**Consensus line**: The median of all available book lines is used — never an extreme, never a single book. This prevents outlier or stale book lines from distorting the probability calculation.

**Source priority**: Odds API (in-play) → Odds API (pre-game) → SGO fallback

**Line fabrication policy**: If no real book line is available for a player/stat combination, the calculation is skipped entirely. Season averages are never used as synthetic prop lines.

---

## 9. Probability Engine

### 9.1 NBA Player Prop Model

**Input parameters**:
- `playerId` — DB player record (season avg, position, minutes)
- `opponentTeam` — for defensive rating lookup
- `halftimeMinutes` — minutes played so far in the game
- `halftimeFouls` — current foul count
- `halftimeStat` — current game stat (e.g., current points)
- `liveLine` — real book line (never synthetic)
- `statType` — one of 11 supported types
- `currentPeriod` — 1, 2, 3, or 4
- `gameClock` — current display clock (e.g. "8:23")

**Model steps**:
1. Compute `gameMinutesRemaining` from period + clock
2. Select baseline: if player has H2 split data and it's the 2nd half, use H2 baseline; otherwise use full-game average
3. Compute `observedRate = halftimeStat / halftimeMinutes` (per minute)
4. Blend: `blendedRate = 0.7 × observedRate + 0.3 × baselineRate`
5. Apply foul penalty: 3 fouls → 30% minute reduction; 4+ fouls → 55% reduction
6. Apply defensive rating multiplier (0.88 – 1.12 scale from opponent `defRating`)
7. Apply pace multiplier (blend of team historical pace with live game pace derived from current score)
8. `expectedTotal = halftimeStat + (projectedMinutes × blendedRate × defMult × paceMult)`
9. `difference = expectedTotal - liveLine`
10. `probability = clamp(50 + difference × scaleFactor, 2, 98)`

**Scale factors** (adjusts sensitivity by stat volatility):
- Points: 8
- Rebounds: 10
- Assists: 10
- Steals/Blocks: 15
- PRA / combo markets: 6

**Garbage time**: In late Q4 with a large spread, minutes are reduced proportionally.

**Progressive clamping**: As the game nears the final minute, probability is clamped to a narrowing range (e.g., 55–90% max in last 2 minutes) to prevent overconfident projections from low remaining sample.

### 9.2 NCAAB 2H Model

**Inputs**: H1 score, current spread, current total line, H1 pace, team identifiers

**Output**: 2H spread probability, 2H total probability, team total probabilities

**Engine vs. book comparison**: Shows engine-derived probability side-by-side with the book-implied probability from the H2 line, letting the user see where there is disagreement.

---

## 10. Database Schema (Key Tables)

### users

| Column | Type | Notes |
|--------|------|-------|
| id | serial PK | |
| email | text unique | |
| password_hash | text | bcrypt, 10 rounds |
| is_admin | boolean | default false |
| subscription_tier | text nullable | `"all"` (Pro) or `"elite"` (All Sports) |
| plays_used | integer | free play counter, max 15 |
| stripe_customer_id | text nullable | |
| stripe_subscription_id | text nullable | |
| phone_number | text nullable | E.164 format |
| sms_alerts | boolean | default false |
| sms_consent | boolean | default false |
| push_alerts | boolean | default false |
| push_subscription | text nullable | serialized Web Push subscription JSON |

### players

| Column | Type | Notes |
|--------|------|-------|
| id | serial PK | |
| name | text | ESPN display name |
| team | text | DB abbreviation (e.g. UTA, GSW) |
| position | text | PG / SG / SF / PF / C |
| avg_minutes | numeric | season average |
| ppg | numeric | season points per game |
| rpg | numeric | season rebounds per game |
| apg | numeric | season assists per game |
| spg | numeric | season steals per game |
| bpg | numeric | season blocks per game |
| tpg | numeric | season 3-pointers per game |
| usage_rate | numeric | |
| def_rating | numeric | opponent defensive rating |

---

## 11. API Routes

### Public (no auth)

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Login by email or phone |
| POST | `/api/webhooks/twilio` | SMS STOP opt-out handler |
| POST | `/api/webhooks/stripe` | Stripe event handler |

### Authenticated (any logged-in user)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/auth/me` | Current user |
| GET | `/api/me` | Extended current user (with NCAAB access flag) |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/players` | Player list |
| POST | `/api/calculate` | NBA prop probability (play-gated) |
| GET | `/api/live-games` | Live NBA scoreboard |
| GET | `/api/live-stats/:gameId` | Live box score for a game |
| GET | `/api/live-signals/:gameId` | Edge signals for box score coloring (90s cache) |
| GET | `/api/odds` | Fetch player prop lines |
| GET | `/api/game-lines` | Fetch game spread + total |
| GET | `/api/injuries` | NBA injury report |
| POST | `/api/parlay/calculate` | Parlay correlation calculation |
| POST | `/api/stripe/create-checkout-session` | Start Stripe checkout |
| POST | `/api/stripe/portal` | Open billing portal |
| PUT | `/api/user/alerts` | Update alert preferences |
| POST | `/api/user/alerts/sms` | Save phone number + SMS toggle |
| POST | `/api/user/alerts/push-subscription` | Register Web Push subscription |
| DELETE | `/api/user/alerts/push-subscription` | Remove push subscription |

### Tier-Gated (Pro or All Sports)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/halftime-plays` | NBA 2H plays across all halftime games |
| GET | `/api/ncaab/games` | Full NCAAB Division I slate |
| GET | `/api/ncaab/plays` | NCAAB computed 2H plays |
| POST | `/api/2h-game-view` | Consume 1 free play (free user game unlock) |

### Admin Only

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/sync-rosters` | Trigger ESPN roster sync |
| GET | `/api/admin/users` | User list |
| PATCH | `/api/admin/users/:id/tier` | Set subscription tier |
| PATCH | `/api/admin/users/:id/reset-plays` | Reset play counter |
| GET | `/api/admin/feedback` | User feedback inbox |

---

## 12. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SESSION_SECRET` | Yes | Express session + JWT signing secret |
| `ADMIN_EMAIL` | Yes | Email for the admin account |
| `ODDS_API_KEY` | Yes | The Odds API key |
| `SGO_API_KEY` | Yes | Sports Game Odds API key |
| `STRIPE_SECRET_KEY` | Yes | Stripe server-side secret key |
| `VITE_STRIPE_PUBLISHABLE_KEY` | Yes | Stripe publishable key (frontend) |
| `TWILIO_ACCOUNT_SID` | Alerts | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Alerts | Twilio auth token |
| `TWILIO_FROM_NUMBER` | Alerts | Twilio sender number (E.164) |
| `VAPID_PUBLIC_KEY` | Push | Web Push VAPID public key |
| `VAPID_PRIVATE_KEY` | Push | Web Push VAPID private key |

---

## 13. Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Vite |
| Routing | Wouter |
| State / Data fetching | TanStack Query v5 |
| Forms | React Hook Form + Zod |
| UI components | shadcn/ui + Tailwind CSS |
| Backend | Express.js (TypeScript, tsx) |
| Database | PostgreSQL via Neon |
| ORM | Drizzle ORM + drizzle-zod |
| Auth | bcrypt + JWT + express-session |
| Payments | Stripe (Checkout + Webhooks) |
| SMS | Twilio |
| Push | Web Push API (VAPID) |
| PWA | Service Worker + Web App Manifest |
| Hosting | Replit Deployments |

---

## 14. Known Behaviors and Edge Cases

- **NCAAB small-conference games**: Lines from small conferences may not appear on major books. The Odds API is queried without bookmaker restriction. If no line is found, the system skips that market rather than projecting a synthetic line.
- **SGO rate limiting**: 429 responses from SGO are cached as a 10-minute backoff. Other markets continue to function.
- **Phone number normalization**: All numbers stored in E.164 format. Numbers entered without country code are normalized to `+1XXXXXXXXXX`.
- **SMS opt-out**: Replying STOP to any SMS immediately unsubscribes the user via Twilio webhook.
- **Line already cleared**: If a player's current stat has already exceeded the prop line at halftime (e.g., player has 20 points with a 17.5-point line), that play is skipped as not actionable.
- **Free play counter**: Only increments on successful calculate responses — errors do not consume plays.
- **Stripe webhooks**: Must be registered in Stripe Dashboard pointing to `https://<domain>/api/webhooks/stripe`.
- **Live signals cache**: The `/api/live-signals/:gameId` endpoint caches results for 90 seconds to avoid repeated odds API calls while the box score refreshes every 2 minutes.
- **Alert deduplication**: NBA alerts use an in-memory fingerprint `playerName|statType|line` per server session. NCAAB halftime alerts use a per-gameId set with a daily reset.

---

## 15. Roadmap

| Priority | Feature | Status |
|----------|---------|--------|
| High | MLB Live data integration | Planned (All Sports gate ready) |
| High | Player prop trend charts / historical hit rate | Planned |
| Medium | User notification history log | Planned |
| Medium | Parlay builder deep-link improvements | Partial (DK/FD/HR/Bet365 live) |
| Low | NFL Live integration | Future |
| Low | Mobile app (React Native) | Future |
