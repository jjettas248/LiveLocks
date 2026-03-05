# LiveLocks — Product Requirements Document
**Version**: 1.4 (March 5, 2026)
**Product**: LiveLocks by PropPulse
**Status**: Active Development

---

## 1. Product Vision

LiveLocks is a live sports betting analytics PWA that gives bettors a real-time probabilistic edge on NBA player props, NCAAB game totals/spreads, and parlay construction. The platform surfaces engine-derived probabilities against current book lines, identifies closing-line value, and packages signals into a parlay builder — all updating live as games progress.

---

## 2. Target Users

| Segment | Description |
|---------|-------------|
| Free Users | Casual bettors exploring NBA props; limited to 15 plays before paywall |
| Pro Users ($40/mo) | Active bettors who want NBA + NCAAB live analytics + alerts |
| All Sports Users ($65/mo) | Power users who want all markets including MLB (coming soon) |
| Admin | Internal product team; jaylin.becker22@icloud.com; full platform access |

---

## 3. Tier Structure

| Feature | Free | Pro (`"all"`) | All Sports (`"elite"`) |
|---------|------|--------------|----------------------|
| NBA Live Props | 15 plays/session | Unlimited | Unlimited |
| NBA 2H Plays | Locked | Yes | Yes |
| NCAAB Live + 2H | No | Yes | Yes |
| MLB Live | No | No | Coming soon |
| Push Notifications | No | Yes | Yes |
| SMS Alerts | No | Yes | Yes (priority) |
| Parlay Builder | Partial | Full | Full |

Stripe price IDs:
- Pro (`all`): `price_1T6fl12cW8Vmrgt3B6ffBIuw` — $40/month
- All Sports (`elite`): `price_1T6fly2cW8Vmrgt3WU9uHL7L` — $65/month

---

## 4. Platform Features (Shipped)

### 4.1 NBA Live Props
- Fetches live ESPN NBA scoreboard; detects halftime automatically
- Retrieves player box scores for all active players in halftime games
- Probability model:
  1. Per-minute rate = 70% halftime observed + 30% season baseline
  2. Adjusted for remaining minutes (foul penalty applied)
  3. Defense multiplier: opponent rating vs player's position
  4. Pace blend: `probability = 50 + diff × scaleFactor` (clamped 2–98%)
- Parlay builder: correlation-adjusted multi-leg parlays with sportsbook deeplinks

### 4.2 NBA 2H Plays
- Filters halftime games for the strongest edges
- Shows projected 2H stats for each player
- Same parlay integration as Live Props

### 4.3 NCAAB Live Analytics
**Data sources:**
1. ESPN Scoreboard (`?limit=300&groups=50`) — all Div I live games
2. ESPN Box Score — scoring by period, team stats, pace data
3. The Odds API — spread/total book lines + American odds
4. Sports Game Odds (SGO) — 1H lines + team total lines per team

**Engine formula (per-market):**
```
overProb = clamp(50 + (projectedTotal − line) × multiplier × 0.3, 1, 99)
```

**Dynamic multiplier table (`getDynamicMultiplier`):**

| Game progress | Multiplier |
|--------------|-----------|
| 0–10% | 3.0 |
| 10–25% | 4.0 |
| 25–50% | 5.0 |
| 50–65% | 6.0 |
| 65–75% | 7.0 |
| 75–85% | 8.0 |
| 85–92% | 10.0 |
| 92–100% / OT | 12.0 |

**Progressive probability limits (`limitedEngineProb`):**

| Progress | Min | Max |
|----------|-----|-----|
| < 10% | 30 | 70 |
| < 25% | 20 | 80 |
| < 50% | 10 | 90 |
| < 75% | 5 | 95 |
| < 90% | 3 | 97 |
| ≥ 90% | 1 | 99 |

**Early-game neutral state (`isNeutralState`):**
When `gameProgress < 10%` AND raw engine prob ∈ [45, 55]:
- Gauge shows "--" and "EARLY GAME"
- Market buttons show "--" (clickable but no probability shown)
- Verdict rows replaced with "Insufficient Data — Engine Warming Up"

**Post-halftime H1 settlement:**
After halftime, `over1HProb` is set to 99 or 1 based on actual H1 total vs H1 line (result is settled).

**sanitizeProb:**
Returns 50 if < 60 seconds of game data has elapsed (prevents wild early swings).

### 4.4 NCAAB Live Game Card
Each live game renders a card with:
- **RadialGauge** — SVG arc showing selected market probability; zinc/teal/red coloring
- **Market buttons** — Over / Under / Spread (3-column grid); teal/red/slate; parlay "+" toggle badge
- **Book pills** — MGM + secondary book showing live line; click → opens sportsbook
- **Stat grid** (6 rows) — Full Game Total line, Engine Over%, Engine Under%, Spread, Away Proj, Home Proj
- **Full Game / 1H tab toggle** — switches all displayed metrics to 1st-half market
- **EV verdict row** — "Strong/Lean [Side] EV" or "Neutral — No Edge"; +Xpp amber pill when edge ≥ 5pp
- **CLV row** — closing line value signal with directional badge
- **H2H Matchup History** — collapsible; dual badges per game (O/U result + spread coverage)
- **Parlay drawer** — bottom sheet showing selected legs from this game

### 4.5 NCAAB Games Strip
- 160px horizontal scrollable chip bar always above the game list
- One chip per game: team abbreviations, live score / halftime indicator / scheduled tipoff time
- Active chip highlighted with teal border
- Chip click: scrolls to and expands the target game card
- Rendered in separate container from `GroupedGamesList` so expanding cards do not push the strip

### 4.6 NCAAB H2H Matchup History
- **Dual-season fetch**: current season first; if < 2 games found → fetch prior season; combine + deduplicate by ESPN event ID; sort descending; max 3 rows
- **Season labels**: prior-season rows show date + "· Prior Season" in zinc italic
- **Insufficient data**: 0 games → "No matchup history found for this season"; 1 game → note below the row
- **Dual badges per row**: O/U result (OVER/UNDER/PUSH/N/A) + spread coverage (covered/failed/PUSH/N/A)
- **Cache**: per-gameId, persists for session

### 4.7 NCAAB 2H Plays
- Filters plays where `bettingWindow === "HALFTIME"`
- Same card structure as live plays; halftime badge shown
- Animated halftime exit transition: orange countdown → bounce → fade in

### 4.8 Team Total Market (In Progress)
- Over/Under buttons per team embedded in the stat grid proj rows
- `selectedTeamMarket` state: `{ team, direction, line, isEstimated, teamAbbr } | null`
- **Line priority chain:**
  1. SGO book line (`homeGameTotalLine` / `awayGameTotalLine`) — `isEstimated: false`
  2. ESPN summary scan (3 locations: `teamTotals`, `pickcenter[0].teamTotals`, `comp.odds[0].teamTotals`) — `isEstimated: false`
  3. `deriveTeamTotalLine(proj) = round(proj × 2) / 2` — `isEstimated: true`
- **Button display**: `O42.5` (book line) or `O~42.5` (estimated)
- **Disabled**: when proj null or out of range (< 10 or > 100 for college)
- **Team Total Verdict Section** (shown when market selected):
  - Divider header: "Team Total · [ABBR] [O/U][line]" + "Est." badge
  - `calculateTeamTotalProb(proj, line) = clamp(50 + (proj - line) × 2, 1, 99)`
  - Estimated confidence compression: `adjustedProb = 50 + (rawProb - 50) × 0.6`
  - EV row + CLV row (same structure as game total verdict rows)
  - Confidence note below when `isEstimated`

### 4.9 Admin Panel (`/admin`)
- View all users with subscription status, play counts, Stripe IDs
- Change subscription tier: `null` → `"all"` → `"elite"` via Stripe API or direct DB
- Reset play count per user
- Read feedback submissions
- Setting `upgradedAt` on tier upgrades (triggers welcome experience)

### 4.10 Welcome Experience (New Pro Users)
Triggered on first visit after upgrading via Stripe or admin:
- **WelcomeBanner**: spring-in animated card at top of dashboard
  - Contextual subtitle: "X games live right now", "X games at halftime", or scheduled count
  - "Explore →" button: switches to NCAAB tab + scrolls to first live/halftime/scheduled game
  - "Dismiss" button: calls `POST /api/user/clear-new-pro-flag`; removes banner
- **NEW badge**: teal animated badge on NCAAB tab; visible for 24h from `upgradedAt`; 30-min re-check timer
- **`expandToGameId`** prop on NCAABAdminTab: `useEffect` expands the target game and scrolls to it

### 4.11 Push Notifications
- Web Push via VAPID keys; `server/webpush.ts`
- User subscribes via bell icon in nav → `POST /api/user/push-subscribe`
- Bell icon flashes on bell-flash keyframe animation when new alert arrives
- Available to Pro/All Sports tiers

### 4.12 SMS Alerts (Twilio)
- Phone capture flow with SMS consent checkbox
- `POST /api/user/alerts/sms` — save phone, trigger test SMS
- `POST /api/webhooks/twilio` — handles STOP keyword → disables SMS
- `server/alertManager.ts` + `server/analyticsResolver.ts` — resolve and dispatch alerts
- Available to Pro/All Sports tiers

### 4.13 Parlay Builder
- **Global parlay slip**: side column on desktop, bottom sheet on mobile (< 1024px)
- Each leg: player/team name, stat label, O/U line, sportsbook, probability
- `ParlayPickInput.isEstimated?: boolean` → shows amber "Est." pill + tooltip for derived team total lines
- Correlation-adjusted probability via `/api/parlay/calculate`
- Sportsbook deeplinks: DraftKings, FanDuel, Hard Rock Bet, Bet365

---

## 5. Technical Architecture

### 5.1 File Map
```
/
├── client/src/
│   ├── pages/
│   │   └── dashboard.tsx         Main app (tabs, parlay slip, modals)
│   ├── components/
│   │   ├── ncaab-admin-tab.tsx   NCAAB Live tab (game cards, strip, H2H)
│   │   ├── parlay-slip.tsx       Parlay slip component
│   │   ├── welcome-banner.tsx    New pro user welcome banner
│   │   └── probability-ring.tsx  SVG ring for NBA player props
│   ├── hooks/
│   │   ├── use-auth.ts           Auth state + JWT management
│   │   └── use-nba.ts            NBA data queries + parlay mutations
│   └── lib/
│       └── queryClient.ts        TanStack Query client + apiRequest
├── server/
│   ├── routes.ts                 All API routes
│   ├── storage.ts                DB interface (IStorage + DrizzleStorage)
│   ├── ncaabService.ts           NCAAB engine + ESPN + SGO integration
│   ├── oddsService.ts            The Odds API client
│   ├── auth.ts                   JWT middleware + safeUser
│   ├── stripeService.ts          Stripe subscription management
│   ├── webhookHandlers.ts        Stripe webhook event handling
│   ├── twilioService.ts          SMS dispatch
│   ├── alertManager.ts           Alert batching + dispatch
│   ├── analyticsResolver.ts      ESPN game score resolution for alerts
│   ├── parlayService.ts          Correlation adjustment engine
│   └── webpush.ts                Web push notification service
├── shared/
│   ├── schema.ts                 DB schema (Drizzle) + TypeScript interfaces
│   └── routes.ts                 Shared route constants
└── docs/
    ├── PRD.md                    This document
    └── DEBUG_LOG.md              Debug session log
```

### 5.2 Key Shared Types
```typescript
ParlayPickInput {
  playerId, playerName, playerTeam, statType, line,
  probability, betDirection, sportsbook, oddsAmerican,
  gameId?, isEstimated?
}

NCAABPlay {
  gameId, homeTeam, awayTeam, homeTeamAbbr, awayTeamAbbr,
  status, clock, half, period, homeScore, awayScore,
  spread, total, favorite, bookLines, overProb, spreadProb,
  over1HProb, h1TotalLine, h1SpreadLine, h1Favorite,
  homeGameTotalLine, awayGameTotalLine, homeGameTotalIsEstimated, awayGameTotalIsEstimated,
  home1HTotalLine, away1HTotalLine,
  projectedTotal, projectedMargin, proj1HTotal,
  homeProjected, awayProjected, volatility, bettingWindow, ...
}

AuthUser {
  id, email, isAdmin, subscriptionTier, playsUsed,
  isNewProUser, upgradedAt
}
```

### 5.3 Database Schema (users table additions)
```sql
isNewProUser   BOOLEAN NOT NULL DEFAULT FALSE
requiresRefresh BOOLEAN NOT NULL DEFAULT FALSE
upgradedAt     TIMESTAMP
```

---

## 6. API Routes

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| POST | `/api/register` | None | Create account |
| POST | `/api/login` | None | JWT login |
| GET | `/api/auth/me` | JWT | Current user |
| POST | `/api/calculate` | JWT + plays | NBA prop probability |
| GET | `/api/halftime-plays` | Pro+ | NBA 2H plays |
| GET | `/api/ncaab/plays` | Pro+ | NCAAB live plays |
| GET | `/api/ncaab/games` | Pro+ | NCAAB scoreboard |
| GET | `/api/ncaab/h2h?gameId=X` | Admin | H2H matchup history |
| POST | `/api/parlay/calculate` | JWT | Parlay probability |
| POST | `/api/stripe/checkout` | JWT | Start subscription |
| POST | `/api/stripe/webhook` | Stripe sig | Webhook events |
| POST | `/api/user/clear-new-pro-flag` | JWT | Clear welcome state |
| POST | `/api/user/push-subscribe` | JWT | Register push sub |
| GET | `/api/user/alerts` | JWT | Get alert settings |
| POST | `/api/user/alerts/sms` | Pro+ | Enable SMS alerts |
| GET | `/api/admin/users` | Admin | All users |
| POST | `/api/admin/change-tier` | Admin | Change user tier |
| POST | `/api/admin/reset-plays` | Admin | Reset play count |
| POST | `/api/live-games` | None | NBA live scoreboard |

---

## 7. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SESSION_SECRET` | Yes | JWT signing secret |
| `ADMIN_EMAIL` | Yes | Admin account email |
| `ODDS_API_KEY` | Yes | The Odds API key |
| `SGO_API_KEY` | Yes | Sports Game Odds key (team totals, 1H) |
| `STRIPE_SECRET_KEY` | Yes | Stripe secret key |
| `VITE_STRIPE_PUBLISHABLE_KEY` | Yes | Stripe publishable key (frontend) |
| `TWILIO_ACCOUNT_SID` | SMS only | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | SMS only | Twilio auth token |
| `TWILIO_FROM_NUMBER` | SMS only | Twilio sender number |
| `VAPID_PUBLIC_KEY` | Push only | Web push VAPID public key |
| `VAPID_PRIVATE_KEY` | Push only | Web push VAPID private key |

---

## 8. Upcoming Features (Next Build Session)

### 8.1 Team Total Verdict Section (T001–T007)
Full implementation plan captured in `.local/session_plan.md`. Summary:
- **T001**: Server H2H dual-season fetch + `isCurrent` flag
- **T002**: ESPN 3-location team total scan + `isEstimated` flags
- **T003**: `isEstimated` field on `ParlayPickInput` schema
- **T004**: `selectedTeamMarket` state + team total buttons in stat grid
- **T005**: `getTeamTotalVerdict` + team total verdict section + parlay pick function
- **T006**: H2HSection season labels + insufficient data states
- **T007**: Parlay slip amber "Est." pill + tooltip

### 8.2 MLB Live (Placeholder)
- Tab exists, shows "coming soon" lock screen
- No backend implementation yet

### 8.3 Possible Future Features
- Player injury feed integration (currently manual via alerts)
- Live odds movement indicators on book pills
- Historical edge tracking per user
- Line shopping across multiple books simultaneously

---

## 9. Debug Log — March 5, 2026

**TypeScript errors found and fixed:**

| File | Line | Issue | Fix |
|------|------|-------|-----|
| `ncaab-admin-tab.tsx` | 1583 | `handleExpandGame: (id: string)` didn't match `onExpandGame: (id: string\|null) => void` | Changed to `(id: string\|null) => { if (id) handleChipClick(id); }` |
| `dashboard.tsx` | 132 | `[...rawData]` on string requires `downlevelIteration` | Changed to `Array.from(rawData)` |
| `dashboard.tsx` | 228 | `.offsetWidth` on `SVGSVGElement` doesn't type-check | Cast to `as unknown as HTMLElement` |
| `dashboard.tsx` | 999 | `new Set([...prev, gameId])` requires `downlevelIteration` | Changed to `new Set(Array.from(prev).concat(gameId))` |
| `analyticsResolver.ts` | 65 | `for...of` on Map requires `downlevelIteration` | Changed to `Array.from(byGameId)` |
| `stripeService.ts` | 66 | Stale `"nba"` tier string in cast | Changed to `"all" \| "elite"` |

**Server status**: Running clean. NCAAB scoreboard returning 40 games (all Final tonight). One NBA game in progress (LAC vs IND, 3rd quarter). No 500 errors, no uncaught exceptions. `/api/auth/me` responding 200ms, `/api/live-games` 186ms.
