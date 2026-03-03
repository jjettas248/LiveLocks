# LiveLocks by PropPulse — Product Requirements Document

**Version**: 2.0  
**Last Updated**: March 2026  
**Status**: Active Development

---

## 1. Product Overview

LiveLocks by PropPulse is a real-time sports analytics and betting intelligence platform designed for NBA and college basketball bettors. The product surfaces live in-game probability models, 2nd-half play recommendations, and NCAAB full-slate coverage — delivered via web app, push notifications, and SMS alerts.

### Vision

Give serious sports bettors a data edge through live statistical modeling they cannot get from sportsbooks or public analytics tools, delivered fast enough to act on during live games.

### Core Value Proposition

- **Live props calculator**: Real-time player prop probability updated as games progress
- **2H Plays**: Halftime model recalculates spread, total, and team-total projections after seeing first-half data
- **Full NCAAB slate**: All Division I games covered daily, not just featured matchups
- **Multi-channel alerts**: Web push + SMS for high-confidence plays and halftime triggers

---

## 2. Users and Access Tiers

### 2.1 User Roles

| Role | Access |
|------|--------|
| Guest (not logged in) | Registration/login only |
| Free (registered, no subscription) | 15 live NBA prop plays, then paywall |
| Pro | Full NBA + NCAAB live + 2H Plays + SMS + Push |
| All Sports | Everything in Pro + MLB Live (coming soon) + Priority SMS |
| Admin | Full access to all features + admin panel |

**Admin account**: `jaylin.becker22@icloud.com`

### 2.2 Subscription Tiers

| Feature | Free | Pro ($40/mo) | All Sports ($65/mo) |
|---------|------|-------------|-------------------|
| NBA Live Props | 15 plays → paywall | Unlimited | Unlimited |
| NBA 2H Plays | Teaser then locked | Yes | Yes |
| NCAAB Live | No | Yes | Yes |
| NCAAB 2H Plays | No | Yes | Yes |
| MLB Live | No | No | Coming Soon |
| Push Notifications | No | Yes | Yes |
| SMS Alerts | No | Yes | Yes (Priority) |
| Parlay Builder | Yes (with plays) | Yes | Yes |

**Internal tier keys**: `"all"` = Pro, `"elite"` = All Sports

### 2.3 Free Play Limit

Free users may view **15 live plays** before hitting the upgrade paywall. The play counter increments on each prop calculation response from the server. Admin and paid users bypass this counter entirely.

---

## 3. Navigation and Tab Structure

```
Top navigation bar:
  [🏀 NBA Live]  [🏀 NCAAB Live]  [⚾ MLB Live 🔒]

When NBA Live is active — secondary pill row appears below:
  [Live Props]  [⏱ 2H Plays]

When NCAAB Live is active — secondary pill row appears below:
  [Live]  [2H Plays]
```

**Visibility rules**:
- **NBA Live**: visible to all logged-in users
- **NCAAB Live**: visible to Pro, All Sports, and Admin users only; hidden from free users
- **MLB Live**: visible to all logged-in users with a lock icon; clicking opens MLB coming-soon popover

---

## 4. Feature Specifications

### 4.1 NBA Live Props (Calculator)

**Inputs**:
- Player name (searchable dropdown, synced from ESPN roster)
- Stat type: Points / Rebounds / Assists / 3-Pointers Made / Steals / Blocks / Pts+Reb+Ast / Pts+Reb / Pts+Ast / Reb+Ast / Stl+Blk
- Current stat value (live)
- Line (from sportsbook)
- Game clock remaining (minutes)
- Period (Q1–Q4 / OT)
- Optional: game total line, halftime score, game spread

**Model logic**:
- Projects final stat based on pace multiplier, usage rate, and game context
- Applies garbage-time reduction when spread exceeds threshold in late Q4
- Returns probability of clearing the line (over/under)
- Probability threshold for high-confidence alert: ≥90% in either direction

**Display**:
- Large probability gauge (ring)
- Over/Under recommendation pill
- Edge percentage vs. implied odds
- Parlay builder appended below high-confidence plays

### 4.2 NBA 2H Plays

Appears as a secondary pill sub-tab under NBA Live (labeled ⏱ 2H Plays). Fetches live halftime games via The Odds API and calculates:

- **2H spread**: adjusted projection using first-half pace and score differential
- **2H total**: remaining scoring projection
- **Team totals**: per-team scoring projection for the second half

Display: game cards sorted by confidence edge. Each card shows spread line + probability bar, total line + probability bar, and color-coded edge pills (green ≥60%, red ≤40%).

**Locking**: Free users see one teaser card blurred, remaining locked behind upgrade prompt.

### 4.3 NCAAB Live

Available to Pro and All Sports subscribers (and admins).

- Pulls full Division I slate daily from ESPN (`limit=300&groups=50` endpoint)
- Shows game cards with: team names, score, period/clock, live win probability
- Real-time probability recalculated using NCAAB pace norms and score context
- Lines fetched from The Odds API (all available bookmakers, not restricted to specific books)

**2H Plays sub-tab**: filters games at halftime and shows spread, O/U, and team total projections. Same display pattern as NBA 2H.

**Access**: No "ADMIN" badge shown. Positioned between NBA Live and MLB Live in tab bar.

### 4.4 MLB Live

Placeholder tab visible to all users. Clicking shows coming-soon popover for free users, upgrade prompt for non-subscribers, and "coming soon" for All Sports subscribers. No live data until MLB season integration is built.

### 4.5 Parlay Builder

Inline feature on all game cards. "Add to Slip" buttons appear as full-width grid rows (Over/Under) below each stat projection section — not as tiny side column buttons. Allows users to:
- Add plays to a running parlay slip
- View combined odds and correlation-adjusted probability
- Deep-link to DraftKings, FanDuel, Hard Rock, or Bet365 with picks copied to clipboard

---

## 5. Registration and Authentication

### 5.1 Registration Form

Required fields:
- **Email** — unique per account
- **Password** — minimum 8 characters
- **SMS Consent checkbox** — required; cannot submit without checking

Optional field:
- **Phone Number** — US number in any common format (555-000-0000, (555) 000-0000, +15550000000); normalized to E.164 (+1XXXXXXXXXX) on save

When the SMS consent checkbox is checked and the user submits:
- `smsConsent = true` stored in DB
- `smsAlerts = true` stored in DB (auto-opted in)
- Phone number stored in DB if provided

### 5.2 Login

Accepts either:
- **Email** + password
- **Phone number** (in any common format) + password — looked up via `phone_number` column

### 5.3 JWT Authentication

- 30-day token expiry
- Stored in localStorage on the client
- Sent as `Authorization: Bearer <token>` header
- Session cookie as fallback

### 5.4 Admin

Admin identified by matching `ADMIN_EMAIL` env variable at registration time. Admin bypasses all tier gates and play limits.

---

## 6. Alerts System

### 6.1 Onboarding Modal

After first login/registration, all users see an "Enable Alerts" modal that:
- Shows the push notifications option (available to all)
- Shows the SMS option (visible only to Pro/All Sports/Admin)
- Prompts to add phone number if not yet set
- Dismissed state stored in `localStorage` (`ll_alerts_onboarded`)

### 6.2 Alert Triggers

**High-confidence play alert**: fires when any live prop reaches ≥90% probability (either direction) for the first time. Uses a deduplication fingerprint: `playerName|statType|line`.

**2H game alert**: fires when a new game enters halftime for the first time per session.

### 6.3 Push Notifications

- Available to Pro and All Sports subscribers
- User opts in via the Alerts panel (bell icon in dashboard header)
- Uses Web Push API (VAPID keys configured server-side)
- Payload: title + body + URL back to dashboard
- Stored as serialized push subscription object in DB

### 6.4 SMS Alerts

- Available to Pro and All Sports subscribers
- User auto-opted in at registration when consent checkbox is checked
- User provides phone number at registration or later via Alerts panel
- Phone stored in E.164 format
- Delivered via Twilio — `TWILIO_FROM_NUMBER` → user's phone
- **Opt-out**: Twilio STOP webhook at `POST /api/webhooks/twilio` — any inbound STOP/UNSUBSCRIBE/CANCEL/END/QUIT sets `smsAlerts = false` and `smsConsent = false` for that user

### 6.5 SMS Compliance

- Consent checkbox required to complete registration
- Consent language: "I explicitly consent to receive SMS text alerts and account notifications from LiveLocks AI. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out."
- Consent stored as boolean in DB (`sms_consent` column)
- STOP keyword processing handled by Twilio webhook

---

## 7. Stripe Payments

### 7.1 Products

| Plan | Internal Key | Monthly Price |
|------|-------------|---------------|
| Pro | `all` | $40 |
| All Sports | `elite` | $65 |

### 7.2 Payment Flow

1. User clicks "Upgrade" → upgrade modal shows 2 plan cards
2. User selects plan → `POST /api/stripe/create-checkout-session` → redirected to Stripe-hosted checkout
3. On success → Stripe webhook `customer.subscription.created` fires → `subscriptionTier` set in DB
4. On cancel/failure → redirect back to dashboard with no tier change
5. Cancellation handled via Stripe billing portal (`POST /api/stripe/portal`)

### 7.3 Upgrade Modal Cards

- **Pro ($40)** — badge: "Best Value" — features: NBA Live Unlimited, NCAAB Live, NBA 2H + NCAAB 2H, Push + SMS Alerts
- **All Sports ($65)** — badge: "Power Users" — features: everything in Pro + MLB Live (Coming Soon) + Priority SMS

---

## 8. Data Sources

| Source | Data | Update Frequency |
|--------|------|-----------------|
| ESPN API | NBA/NCAAB live scores, rosters, game clocks | Polled every 60–90s |
| The Odds API | NBA 2H lines, NCAAB spreads/totals/1H lines | Every 5 min (NCAAB), on halftime detection (NBA) |
| Twilio | Inbound STOP messages | Webhook (real-time) |

### 8.1 ESPN Roster Sync

- Runs on demand via admin panel → "Sync Rosters" button
- Maps ESPN team abbreviations to DB abbreviations via `ESPN_TO_DB` map
- Key mappings: `UTAH → UTA`, `UTH → UTA`, `GS → GSW`, `NY → NYK`, `NO → NOP`, `SA → SAS`, `WSH → WAS`, etc.
- ESPN position codes mapped: `G → SG`, `F → SF`, `FC → PF`, `C → C`, `PG → PG`
- Upsert by player name — updates team/position if exists, inserts if new

### 8.2 The Odds API — NCAAB

- Requests `spreads,totals,h1_totals,h1_spreads` markets
- **All bookmakers queried** (no restriction) to maximize coverage of small-conference games
- TTL: 5 minutes for odds data; 90s for scoreboard; 60s for box scores

---

## 9. Database Schema (Key Tables)

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
| phone_number | text nullable | E.164 format (+1XXXXXXXXXX) |
| sms_alerts | boolean | default false; true if consented at signup |
| sms_consent | boolean | default false; required at registration |
| push_alerts | boolean | default false |
| push_subscription | text nullable | serialized Web Push subscription |

### players

| Column | Type | Notes |
|--------|------|-------|
| id | serial PK | |
| name | text | |
| team | text | DB abbreviation (e.g. UTA, GSW) |
| position | text | PG/SG/SF/PF/C |
| avg_minutes | numeric | season average |
| avg_points | numeric | |
| avg_rebounds | numeric | |
| avg_assists | numeric | |
| usage_rate | numeric | |
| fg_percentage | numeric | |
| three_point_percentage | numeric | |

---

## 10. API Routes

### Public (no auth)

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/auth/register` | Create account (email + password + optional phone + smsConsent) |
| POST | `/api/auth/login` | Login by email or phone number |
| POST | `/api/webhooks/twilio` | SMS STOP opt-out handler |
| POST | `/api/webhooks/stripe` | Stripe event handler |

### Authenticated (any logged-in user)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/auth/me` | Current user |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/players` | Player list |
| POST | `/api/calculate` | NBA prop probability (play-gated) |
| POST | `/api/stripe/create-checkout-session` | Start Stripe checkout |
| POST | `/api/stripe/portal` | Open billing portal |
| PUT | `/api/user/alerts` | Update alert preferences |
| POST | `/api/user/alerts/sms` | Save phone number + SMS toggle |
| POST | `/api/user/alerts/push-subscription` | Register Web Push subscription |
| DELETE | `/api/user/alerts/push-subscription` | Remove Web Push subscription |

### Tier-Gated (Pro or All Sports)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/halftime-plays` | NBA 2H plays |
| GET | `/api/ncaab/games` | NCAAB full slate |
| GET | `/api/ncaab/plays` | NCAAB computed plays with probabilities |

### Admin Only

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/sync-rosters` | Trigger ESPN roster sync |
| GET | `/api/admin/users` | User list |

---

## 11. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SESSION_SECRET` | Yes | Express session + JWT secret |
| `STRIPE_SECRET_KEY` | Yes | Stripe server-side key |
| `VITE_STRIPE_PUBLISHABLE_KEY` | Yes | Stripe client-side key |
| `ODDS_API_KEY` | Yes | The Odds API key |
| `TWILIO_ACCOUNT_SID` | Yes | Twilio account identifier |
| `TWILIO_AUTH_TOKEN` | Yes | Twilio auth token |
| `TWILIO_FROM_NUMBER` | Yes | Twilio sender number (E.164) |
| `ADMIN_EMAIL` | Yes | Email address for admin account |
| `VAPID_PUBLIC_KEY` | Yes | Web Push public key |
| `VAPID_PRIVATE_KEY` | Yes | Web Push private key |

---

## 12. Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Vite |
| Routing | Wouter |
| State / Data fetching | TanStack Query v5 |
| Forms | React Hook Form + Zod |
| UI components | shadcn/ui + Tailwind CSS |
| Backend | Express.js (TypeScript) |
| Database | PostgreSQL via Neon |
| ORM | Drizzle ORM + drizzle-zod |
| Auth | bcrypt + JWT + express-session |
| Payments | Stripe (Checkout + Webhooks) |
| SMS | Twilio |
| Push Notifications | Web Push API (VAPID) |
| Hosting | Replit (dev) + Replit Deployments (prod) |

---

## 13. Known Behaviors and Edge Cases

- **NCAAB small-school games**: Lines from small conferences may not be on major books. The Odds API is queried without bookmaker restriction to maximize coverage. If no line is found, the system projects using its own pace model and notes "(proj)" next to lines.
- **Phone number format**: All phone numbers stored in E.164 format. Numbers entered without country code are normalized to `+1XXXXXXXXXX` automatically.
- **SMS opt-out**: Replying STOP to any SMS unsubscribes the user immediately via Twilio webhook.
- **Twilio trial accounts**: Can only SMS verified numbers until account is upgraded.
- **Free play counter**: Only increments on successful calculate responses — errors do not consume plays.
- **Stripe webhooks**: Must be registered in Stripe Dashboard pointing to `https://<domain>/api/webhooks/stripe`.
- **NCAAB 1H lines**: The `h1_totals` and `h1_spreads` markets are requested from The Odds API. If unavailable for a specific game, the system estimates 1H total using 47% of the full-game line.

---

## 14. Roadmap

| Priority | Feature | Status |
|----------|---------|--------|
| High | MLB Live data integration (All Sports gate ready) | Planned |
| High | Player prop history / trend charts | Planned |
| Medium | Parlay builder export to sportsbook deep link | Partial (DK/FD/HR/Bet365 deeplinks live) |
| Medium | User notification history log | Planned |
| Low | NFL Live integration | Future |
| Low | Mobile app (React Native) | Future |
