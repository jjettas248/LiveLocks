# LiveLocks by PropPulse — Product Requirements Document

**Version**: 5.1
**Last Updated**: April 2026
**Status**: Active — NBA (archetype engine) + NCAAB Live + MLB Phase A (distribution engine) + MLB HR Radar Goldmaster v1 (signal-surfacing layer)

---

## 1. Product Overview

LiveLocks by PropPulse is a real-time sports betting analytics platform for serious NBA, NCAAB, and MLB bettors. It surfaces archetype-based probability models, 2nd-half play recommendations, full-slate NCAAB coverage with CLV edge and public bet fade, and an MLB Phase A distribution-first prop engine — delivered as a PWA with push notifications, SMS alerts, and email lifecycle engagement.

### Vision

Give serious sports bettors a data edge through live statistical modeling they cannot get from sportsbooks or public analytics tools, fast enough to act on during live games.

### Core Value Proposition

- **NBA archetype-based engine**: 7 player archetypes with Z-score probability, fragility scoring, calibration shrinkage, and safety ceilings — see [NBA_Model_Logic.md](NBA_Model_Logic.md)
- **Live box score edge detection**: Automatic inline market badges with rotation when the engine finds an edge on any player's book line — no manual input required
- **2H Plays**: Halftime engine recalculates full-game prop projections for all live halftime games simultaneously, surfaces top plays sorted by confidence
- **Full NCAAB slate**: All Division I games covered daily with canonical market objects, Top Plays feed, CLV edge + public bet fade layer, confidence tiers (ELITE/STRONG/VALUE/NONE) — see [NCAAB_Engine_Logic.md](NCAAB_Engine_Logic.md)
- **MLB Phase A**: 10 prop markets with distribution-first probability (Negative Binomial, Binomial, Normal CDF), 8 batter + 6 pitcher archetypes, Statcast-driven classification, PA distribution model — see [MLB_Engine_Logic.md](MLB_Engine_Logic.md)
- **Conversion engine**: Daily play reset, teaser values, upgrade CTAs, Recent Wins strip, edge feed conversion gate
- **Email lifecycle**: Resend transactional email with verification flow, auto-login, lifecycle cron, ROI wall email
- **Play grading**: Persisted plays with automated grading, calibration dashboard, track record metrics (admin-only)
- **Multi-channel alerts**: Web push and SMS for high-confidence plays and new halftime triggers
- **Landing page**: Public entry point with real product screenshots, feature highlights, pricing, and upgrade CTAs

---

## 2. Users and Access Tiers

### 2.1 User Roles

| Role | Access |
|------|--------|
| Guest (not logged in) | Landing page, privacy, terms, registration and login pages |
| Free (registered, email verified) | 3 live prop calculations per day (daily reset), then paywall; first 5 2H Play edges visible, rest blurred with teaser values |
| Pro | Unlimited NBA + NCAAB live + 2H Plays + Push + SMS |
| All Sports | Everything in Pro + MLB Live + Priority SMS |
| Admin | Full access to all features + admin panel + simulation mode + calibration dashboard + no limits |

**Admin account**: Set via `ADMIN_EMAIL` environment variable at registration time.

### 2.2 Subscription Tiers

| Feature | Free | Pro ($40/mo) | All Sports ($65/mo) |
|---------|------|-------------|-------------------|
| NBA Live Props | 3 plays/day then paywall | Unlimited | Unlimited |
| Live Box Score Edge Signals | No | Yes | Yes |
| NBA 2H Plays | First 5 edges visible, rest blurred with teaser values | Yes | Yes |
| NCAAB Live | No | Yes | Yes |
| NCAAB 2H Plays | No | Yes | Yes |
| MLB Live | No | No | Yes |
| Push Notifications | No | Yes | Yes |
| SMS Alerts | No | Yes | Yes (Priority) |
| Parlay Builder | Yes (within play limit) | Yes | Yes |

**Internal tier keys**: `"all"` = Pro, `"elite"` = All Sports, `null` = Free

### 2.3 Free Play Limit

Free users may perform **3 live prop calculations per day** before hitting the upgrade paywall. The counter resets daily at midnight UTC. Admin and paid users bypass the counter. Errors do not consume plays.

---

## 3. Navigation and User Journey

### 3.1 Landing Page Journey

| Step | Route | Description |
|------|-------|-------------|
| 1 | `/` | Guest lands on the public landing page with real product screenshots, feature highlights, and pricing cards |
| 2 | `/auth` | Guest clicks "Get Started" or "Sign Up" CTA |
| 3 | (email) | User receives verification email via Resend |
| 4 | `/verify-pending` | User sees verification pending page; clicks email link to verify |
| 5 | `/dashboard` | User lands on the main dashboard |

### 3.2 Route Table

| Path | Auth Required | Description |
|------|--------------|-------------|
| `/` | No | Landing page (redirects to `/dashboard` if authenticated) |
| `/landing` | No | Landing page (direct access) |
| `/auth` | No | Login / Register |
| `/verify-pending` | No | Email verification pending / landing |
| `/dashboard` | Yes | Main application — NBA, NCAAB, MLB tabs |
| `/admin` | Yes (Admin) | Admin panel — user management, simulation, calibration |
| `/privacy` | No | Privacy policy |
| `/terms` | No | Terms of service |

### 3.3 Tab Structure

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
- **MLB Live**: visible to All Sports and Admin users; lock indicator for others

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
- Fetches real book lines from approved books (DraftKings, FanDuel, Hard Rock Bet, PrizePicks, Underdog Fantasy) — never fabricates a line
- Runs the archetype-based probability engine with the actual current period and clock
- Only returns signals where edge ≥5% from 50%

**Inline market badges** (replaced dot signals in Task #39/#105):
- Each player row shows rotating inline badges for markets where the engine detects an edge
- Badges show the market type (PTS, REB, AST) and direction (OVER/UNDER)
- Color-coded by confidence tier

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

**Auto-fill from box score**: Clicking a player row in the box score populates all calculator fields automatically. Opponent team is auto-set when a player is selected from a game tile.

**Auto-fetch odds**: When player + stat type are selected, the odds panel queries The Odds API and displays per-book lines. User can set the line manually or use the fetched median.

**Output**:
- Probability gauge (circular ring), labeled percentage
- Hit Implied percentage
- Over/Under call label
- Edge vs. book-implied odds
- "Add to Parlay" button
- Tweet/copy block (always visible when result exists) with rotating template system

### 4.3 NBA 2H Plays

Appears as a sub-tab under NBA Live (labeled "2H Plays"). Fetches all live NBA games at halftime, then for each game:

1. Fetches ESPN box score summary
2. For each player with ≥3 minutes at halftime, checks all 11 stat type combinations
3. Looks up book lines (Odds API live → pre-game → SGO) from approved books only — skips if no real line found
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

**Locking for free users**: Free users see the first 5 edges with full detail. Remaining plays are blurred with teaser values (showing the stat type and a partially obscured probability) and an upgrade banner prompting subscription.

### 4.4 NCAAB Live

Available to Pro, All Sports, and Admin users.

**Canonical market object**: The engine produces a structured `markets` object for each game containing six canonical keys — full_total, full_spread, h1_total, h1_spread, h2_total, h2_spread — each with projection, probability, edge, CLV, and public bet data. This canonical structure ensures consistent behavior across the Live and 2H Plays tabs.

**Top Plays feed**: Displayed first (above the Today's Games strip) to give high-confidence plays immediate visibility. Top Plays are sorted by edge confidence and show probability gauges, engine vs. book comparison, and add-to-slip buttons.

**Game strip**: Horizontal scrollable chip bar showing all live and scheduled NCAAB games below the Top Plays feed. Clicking a chip scrolls to that game's card and highlights it.

**Book filter pills**: Filter bar with pills for All / DK / FD / HR / ESPN Bet, allowing users to view lines from a specific sportsbook or the consensus across all books.

**CLV Edge + Public Bet Fade**: Each market shows CLV edge (line movement since close) and public bet percentage. When the line has moved toward public money without book adjustment, a fade recommendation is surfaced.

**Confidence tiers**: ELITE (≥12 edge), STRONG (≥8), VALUE (≥4), NONE (<4). Derived lines (not from sportsbooks) are capped at STRONG.

**Game cards** display:
- Team names, current score, period/clock
- Market buttons: Spread, Total, H1 Total, H1 Spread
- Radial probability gauges for each market
- EV verdict label (Strong Over / Slight Under / etc.)
- CLV edge + public bet percentage indicators
- Live win probability (based on score differential and pace)
- H2H matchup history toggle
- "Add to Slip" buttons for parlay builder

**Data sources**: ESPN (live scores) + The Odds API (all available bookmakers) + SGO (1H lines, team totals fallback).

**NCAAB 2H Engine**:
- Runs for games at halftime with real book lines
- Computes 2H spread, 2H total, and team totals
- Shows "Engine: X%" vs "Book: Y%" comparison
- H2 projection display: `{H1 score} + ~{projected H2} = {projected final}` format
- Alert deduplication: one alert per gameId per calendar day via in-memory set

### 4.5 Parlay Builder

**Activation**: "Add to Parlay" buttons appear below each prop and on NCAAB game cards.

**Functionality**:
- Running slip of added plays showing combined odds and correlation-adjusted probability
- On mobile: fixed bottom sheet with handle to expand
- On desktop: side column panel
- Correlation adjustments: same-game parlays are discounted for known correlations (e.g. points and PRA from the same player)
- Deeplinks: DraftKings, FanDuel, Hard Rock, Bet365 — picks copied to clipboard on click

### 4.6 MLB Live (Phase A)

**Status**: Phase A — available to All Sports and Admin users. 10 prop markets with distribution-first probability architecture.

**10 Prop Markets**:
1. Hits
2. Total Bases
3. Pitcher Strikeouts
4. Home Runs
5. Hits+Runs+RBIs (HRR)
6. Batter Strikeouts
7. Pitcher Outs
8. Hits Allowed
9. Walks Allowed
10. HR Allowed

**Distribution-first architecture**: Each market uses the statistically optimal distribution model — Negative Binomial for over-dispersed counts (Hits, TB, HRR), Binomial for binary per-PA outcomes (K, HR), Normal CDF fallback for remaining markets.

**Archetype system**: 8 batter archetypes (elite_contact, power_first, stable_regular, contact_specialist, platoon_hitter, hot_streak, cold_streak, limited_sample) and 6 pitcher archetypes (ace, quality_starter, mid_rotation, back_end, opener_bulk, volatile_arm). Classification is driven by Statcast metrics (xBA, barrel rate, exit velocity).

**PA Distribution Model**: Estimates remaining plate appearances based on inning, batting order slot, and run-scoring pace. Integrated into distribution probability via weighted sums across discrete PA scenarios.

**Feature engineering**: Contact quality classification (ELITE/HARD/MEDIUM/SOFT), pitcher context, lineup context, handedness matchup, weather/environment — combined into a composite context score.

**Experimental market dampening**: Home Runs, Batter Strikeouts, and HR Allowed receive a 0.90× edge reduction to prevent overconfident signals on less-validated markets.

**Tier gating**: MLB Live is gated to All Sports (`"elite"`) subscribers. The gate is enforced server-side.

### 4.6.1 MLB HR Radar (Goldmaster v1 — Track / Build / Ready / Fire ladder)

The HR Radar is a dedicated tab inside MLB Live that surfaces home-run probability builds in real time across every live game. It runs on top of the existing distribution engine and does not modify any engine math, scoring, or calibration.

**User-facing ladder** (Goldmaster v1):

| Stage | Color | What it means |
|---|---|---|
| **TRACK** | gray | Conditions are forming. Not actionable yet. Use to scout. |
| **BUILD** | blue | Pattern is building. One more quality contact or worsening pitcher context could make this playable. |
| **READY** | orange | Playable HR setup. Contact quality and matchup context are aligned. |
| **FIRE** | red (pulse) | Highest-conviction HR window is open right now. |
| **RESOLVED** | gray | Resolved as a HIT, MISS, or COOLED OFF. |

**0–10 score**: Every row shows a `currentSignalScore10` (0.0–10.0, one decimal). Track rows that have not yet emitted a readiness number get a display-only fallback (Track 2.5 / Build 5.5 / Ready 7.5 / Fire 9.0) so users never see a meaningless 0.0. Fallback scores are NEVER used for grading.

**Qualifying signals**: Each row carries a `qualifyingSignals` array drawn from the engine's diagnostic snapshot:

`elite_barrel`, `near_barrel`, `two_hard_hit_balls`, `deep_fly_warning`, `high_bat_speed_lift`, `pitcher_collapse_power`, `late_game_power_build`, `massive_single_contact`, `pre_hr_danger`.

The user-stage is the STRONGER of (a) the legacy mapped stage from the existing engine state and (b) the suggested stage derived from these qualifying signals — strictly additive, never destructive.

**Stage timestamps** (additive, surfaced on the wire, write-once when persisted): `firstTrackedAt/Inning`, `firstBuiltAt/Inning`, `firstReadyAt/Inning`, `firstFireAt/Inning`, `hrOccurredAt/Inning`.

**Official signal stage**: `officialSignalStage` is set only when a row reaches `ready` or `fire`. Track and Build rows are never counted as "official misses" against the radar grade.

**Grading sub-buckets** (additive — original `dead`/`missed`/`hit` buckets unchanged): per-day `subBuckets` on `/api/mlb/hr-radar-grading-history` adds five new keys for finer analysis: `missedOfficialSignals`, `lateSignals`, `uncalledHrs`, `earlyWindowHrs`, `expiredTracking`.

**Feature flag**: `HR_RADAR_GOLDMASTER_V1` (default ON; set to `false`/`0`/`off`/`no` to disable). When OFF, the legacy and board endpoints emit zero v1-only fields and the ladder falls back to the original five sections (no Ready bucket, original ATTACK NOW / BUILDING / WATCH labels). Engine math is identical in both states.

**Standing rule**: never modify HR engines, scoring math, or calibration. Goldmaster v1 is purely a surfacing/qualification layer. Detailed reference: [docs/SIGNAL_ENGINE_REFERENCE.md](docs/SIGNAL_ENGINE_REFERENCE.md).

### 4.7 Conversion Engine

**Daily play reset**: Free users get 3 plays per day (resets at midnight UTC), replacing the original 15-play lifetime cap.

**Edge feed conversion gate**: Free users see limited edges in the feed with upgrade prompts. Paid users get full access to all engine signals.

**Teaser values**: Blurred plays show the stat type and a partially obscured probability to demonstrate value.

**Recent Wins strip**: Horizontal strip displaying recent successful engine picks to build user confidence and drive conversion.

**Upgrade CTAs**: Contextual upgrade prompts appear when free users hit limits, view blurred plays, or access locked features.

### 4.8 Email Lifecycle

**Provider**: Resend (transactional email via `RESEND_API_KEY`)

**Verification flow**:
1. User registers → verification email sent via Resend
2. User clicks verification link → `/verify-pending` page (auto-login after verification)
3. Auto-login + redirect to dashboard with toast notification

**Lifecycle emails**:
- Welcome email on registration
- Verification reminders for unverified users
- ROI wall email showcasing engine track record
- Lifecycle cron (15-minute interval) for scheduled sends

### 4.9 Play Grading + Calibration Dashboard

**Persistence**: All engine plays are persisted to the database with outcomes graded automatically using live game data.

**Calibration dashboard** (admin-only): Shows engine track record including hit rates per market type, ROI metrics, and calibration accuracy.

**Track record**: Admin-gated display of historical engine performance.

### 4.10 Admin Simulation Mode

Admin-only feature allowing probability calculations with synthetic inputs (custom stats, minutes, game state) without affecting live data or persisted plays. Used for engine testing and calibration validation.

---

## 5. Registration and Authentication

### 5.1 Registration Form

Required:
- **Email** — unique per account
- **Password** — minimum 8 characters
- **SMS Consent checkbox** — required; cannot submit without checking

Optional:
- **Phone Number** — US number in any common format; normalized to E.164 (`+1XXXXXXXXXX`) on save

On submission:
- Verification email sent via Resend
- `smsConsent = true` stored in DB
- `smsAlerts = true` stored in DB (auto-opted in)
- Phone number stored if provided

### 5.2 Email Verification

- Verification token generated at registration
- Email sent via Resend with verification link
- `/api/auth/verify-email?token=...` validates token and marks user as verified
- Auto-login after verification with redirect to dashboard
- Verification reminder emails sent for unverified accounts

### 5.3 Login

Accepts either:
- **Email** + password
- **Phone number** (any common format) + password — looked up via `phone_number` column

### 5.4 JWT Authentication

- 30-day token expiry
- Stored in localStorage as `ll_auth_token`
- Sent as `Authorization: Bearer <token>` header on every request
- Session cookie maintained as fallback
- Either method is accepted server-side

### 5.5 Admin Account

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
| NBA high-confidence play | ≥85% hit implied (`edge ≥ 35`) | Per `playerName\|statType\|line` per session |
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

Price IDs are configured via environment variables (not hardcoded).

### 7.2 Payment Flow

1. User clicks "Upgrade" → upgrade modal shows two plan cards
2. User selects plan → `POST /api/stripe/create-checkout-session` → redirected to Stripe-hosted checkout
3. On success → Stripe webhook `customer.subscription.created` → `subscriptionTier` set in DB
4. On cancel/failure → redirected back to dashboard with no tier change
5. Cancellation managed via Stripe billing portal (`POST /api/stripe/portal`)

### 7.3 Upgrade Modal

- **Pro ($40/mo)** — badge: "Best Value" — features: NBA Live Unlimited, NCAAB Live, NBA + NCAAB 2H Plays, Push + SMS Alerts
- **All Sports ($65/mo)** — badge: "Power Users" — features: everything in Pro + MLB Live + Priority SMS

---

## 8. Data Sources and Caching

| Source | Data | Cache TTL |
|--------|------|-----------|
| ESPN Scoreboard API | Live NBA/NCAAB/MLB scores | 30s |
| ESPN Summary API | Box score per game | 90s |
| ESPN Injuries API | NBA injury report | 5 min |
| The Odds API (live) | In-play prop lines | 90s |
| The Odds API (pre-game) | Pre-game prop lines | 5 min |
| The Odds API (NCAAB) | Spreads, totals, H1 lines | 5 min |
| Sports Game Odds (SGO) | NCAAB 1H/team-total lines | Rate-limited; 10-min backoff on 429 |
| NBA.com / ESPN Stats | Season per-game averages, H2 splits | Daily (sync on demand) |
| Baseball Savant | Statcast metrics (xBA, barrel rate, exit velocity) | Daily |

### 8.1 Approved Books (Line Sourcing)

DraftKings, FanDuel, Hard Rock Bet, PrizePicks, Underdog Fantasy.

Lines from other books are excluded. If no approved-book line is available, the play is skipped — no synthetic lines are ever used.

### 8.2 ESPN Abbreviation Mapping

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

### 8.3 Odds Line Methodology

**Consensus line**: The median of all available book lines is used — never an extreme, never a single book. This prevents outlier or stale book lines from distorting the probability calculation.

**Source priority**: Odds API (in-play) → Odds API (pre-game) → SGO fallback

**Line fabrication policy**: If no real book line is available for a player/stat combination, the calculation is skipped entirely. Season averages are never used as synthetic prop lines.

---

## 9. Probability Engines

Detailed engine behavior is documented in separate files:

| Engine | Document | Key Features |
|--------|----------|-------------|
| NBA | [NBA_Model_Logic.md](NBA_Model_Logic.md) | 7 archetypes, Z-score/Normal CDF, fragility scoring, calibration shrinkage, safety ceilings |
| MLB | [MLB_Engine_Logic.md](MLB_Engine_Logic.md) | NegBin/Binomial/Normal CDF distributions, 8 batter + 6 pitcher archetypes, PA distribution, Statcast |
| NCAAB | [NCAAB_Engine_Logic.md](NCAAB_Engine_Logic.md) | Pace-based projection, dynamic multiplier, CLV edge, public bet fade, confidence tiers |

### 9.1 Shared Engine Services

| Service | File | Description |
|---------|------|-------------|
| Engine Input Builder | `server/services/engineInputBuilder.ts` | Unified input construction for all engines |
| Engine Signal | `server/services/engineSignal.ts` | Signal output formatting + confidence tier computation |
| Engine Validation | `server/services/engineValidation.ts` | Validation firewall for all engine outputs |
| Engine Stats | `server/services/engineStats.ts` | Observability metrics + stats tracking |
| Consensus Line | `server/services/consensusLineService.ts` | Median consensus line computation |
| Normalization | `server/services/normalizationService.ts` | Team abbreviation + data normalization |
| Timing | `server/services/timingService.ts` | Freshness checks + timing gates |

### 9.2 Signal Stability Filters (NBA Post-Calibration)

Three lightweight filters run after calibration and before the result is returned:

1. **Low-minute bench volatility filter**: When `effectiveMinutesBase < 24 AND minutesPlayed < 12`, probability is multiplied by 0.92
2. **High-usage UNDER collapse guard**: UNDER calls where `usageRate > 0.26` have probability reduced by 3 points
3. **Combo-stat variance dampener**: Combo markets (stat type contains `_`) have probability multiplied by 0.97

---

## 10. Database Schema (Key Tables)

### users

| Column | Type | Notes |
|--------|------|-------|
| id | serial PK | |
| email | text unique | |
| password_hash | text | bcrypt, 10 rounds |
| is_admin | boolean | default false |
| email_verified | boolean | default false |
| verification_token | text nullable | |
| subscription_tier | text nullable | `"all"` (Pro) or `"elite"` (All Sports) |
| plays_used | integer | free play counter, resets daily |
| plays_reset_date | text nullable | date of last daily reset |
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

### persisted_plays

| Column | Type | Notes |
|--------|------|-------|
| id | serial PK | |
| sport | text | NBA / NCAAB / MLB |
| player_name | text | |
| stat_type | text | |
| line | numeric | |
| probability | numeric | Engine probability at time of play |
| direction | text | OVER / UNDER |
| result | text nullable | HIT / MISS / PUSH / null (pending) |
| created_at | timestamp | |

---

## 11. API Routes

### Public (no auth)

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/auth/register` | Create account (sends verification email) |
| POST | `/api/auth/login` | Login by email or phone |
| GET | `/api/auth/verify-email` | Verify email token |
| POST | `/api/webhooks/twilio` | SMS STOP opt-out handler |
| POST | `/api/webhooks/stripe` | Stripe event handler |

### Authenticated (any logged-in user)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/auth/me` | Current user |
| GET | `/api/me` | Extended current user (with access flags) |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/players` | Player list |
| POST | `/api/calculate` | NBA prop probability (play-gated, daily reset) |
| GET | `/api/live-games` | Live NBA scoreboard |
| GET | `/api/live-stats/:gameId` | Live box score for a game |
| GET | `/api/live-signals/:gameId` | Edge signals for box score (90s cache) |
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

### All Sports Gated

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/mlb/live-games` | MLB game schedule + live scores |
| GET | `/api/mlb/live-signals/:gameId` | MLB player signals for a game |
| GET | `/api/mlb/edge-feed` | MLB cross-game edge feed |
| POST | `/api/mlb/calculate-manual` | MLB manual prop calculation |
| GET | `/api/mlb/hr-radar` | Legacy HR Radar (now v1-enriched when flag is on) |
| GET | `/api/mlb/hr-radar-board` | HR Radar live board rows |
| GET | `/api/mlb/hr-radar/ladder` | HR Radar ladder grouped by stage (Fire / Ready / Build / Track / Resolved) |
| GET | `/api/mlb/hr-radar-analyze/:playerId/:gameId` | AB-by-AB analyze modal |
| GET | `/api/mlb/hr-radar-grading-history` | Per-day W/L summaries + v1 sub-buckets (last 14 days) |
| GET | `/api/mlb/hr-radar-grading/:sessionDate` | Historical day's graded outcomes |

### Admin Only

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/sync-rosters` | Trigger ESPN roster sync |
| GET | `/api/admin/users` | User list |
| PATCH | `/api/admin/users/:id/tier` | Set subscription tier |
| PATCH | `/api/admin/users/:id/reset-plays` | Reset play counter |
| GET | `/api/admin/feedback` | User feedback inbox |
| POST | `/api/admin/mlb/grade` | Trigger MLB play grading |
| GET | `/api/admin/mlb/grading-summary` | MLB grading summary + ROI |

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
| `RESEND_API_KEY` | Yes | Resend API key (transactional email) |
| `TWILIO_ACCOUNT_SID` | Alerts | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Alerts | Twilio auth token |
| `TWILIO_FROM_NUMBER` | Alerts | Twilio sender number (E.164) |
| `VAPID_PUBLIC_KEY` | Push | Web Push VAPID public key |
| `VAPID_PRIVATE_KEY` | Push | Web Push VAPID private key |
| `HR_RADAR_GOLDMASTER_V1` | No | Default ON. Set to `false`/`0`/`off`/`no` to disable the v1 surfacing layer (Track/Build/Ready/Fire ladder, 0–10 score, qualifying signals, additive grading sub-buckets). |
| `DEBUG_HR_RADAR_V1` | No | When `true` AND `HR_RADAR_GOLDMASTER_V1` is on, emits one `[HR_RADAR_V1_TRACE]` JSON log per ladder row for shadow-grading validation. Off by default. |

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
| Email | Resend (transactional email) |
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
- **Free play counter**: Only increments on successful calculate responses — errors do not consume plays. Resets daily at midnight UTC.
- **Stripe price IDs**: Configured via environment variables, not hardcoded. Must match the live Stripe account.
- **Stripe webhooks**: Must be registered in Stripe Dashboard pointing to `https://<domain>/api/webhooks/stripe`.
- **Live signals cache**: The `/api/live-signals/:gameId` endpoint caches results for 90 seconds to avoid repeated odds API calls while the box score refreshes every 2 minutes.
- **Alert deduplication**: NBA alerts use an in-memory fingerprint `playerName|statType|line` per server session. NCAAB halftime alerts use a per-gameId set with a daily reset.
- **Email verification**: Users who haven't verified their email receive reminder emails. Auto-login is triggered after successful verification.
- **Derived NCAAB lines**: Lines estimated from data (not from sportsbooks) are capped at STRONG confidence — they cannot achieve ELITE tier.
- **MLB experimental markets**: Home Runs, Batter Strikeouts, and HR Allowed receive a 0.90× edge dampening factor due to lower historical validation.
- **Approved books only**: NBA engine only uses lines from DraftKings, FanDuel, Hard Rock Bet, PrizePicks, and Underdog Fantasy. Lines from other books are excluded.

---

## 15. Roadmap

| Priority | Feature | Status |
|----------|---------|--------|
| High | MLB Phase B — expanded public markets, enhanced live game cards | Planned |
| High | Player prop trend charts / historical hit rate | Planned |
| Medium | Parlay builder deep-link improvements | Partial (DK/FD/HR/Bet365 live) |
| Medium | User notification history log | Planned |
| Low | NFL Live integration | Future |
| Low | Mobile app (React Native) | Future |
