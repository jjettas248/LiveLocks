# LiveLocks — Product Requirements Document

**Version**: 2.2 (June 15, 2026)
**Product**: LiveLocks by PropPulse
**Status**: Production

---

## 1. Product Vision

LiveLocks is a real-time sports betting analytics PWA that gives bettors a data-driven probabilistic edge on MLB player props, NBA player props, and NCAAB game markets. The platform surfaces engine-derived probabilities against real sportsbook lines, delivers live signals updating every 10 seconds during games, and packages insights into actionable cards with confidence tiers, matchup intelligence, and HR radar alerts.

**Core Principle:** No synthetic defaults — every signal must be backed by a real sportsbook line with verified odds. If no book is offering a market, the engine skips it.

---

## 2. Target Users

| Segment | Description |
|:---|:---|
| Recreational bettors | Want quick, trustworthy picks with clear confidence levels |
| Sharp bettors | Need edge calculations, probability distributions, and live matchup intelligence |
| DFS players | Benefit from hot hitter detection, pitcher arsenal analysis, and live contact data |
| Admin | Internal product team; full platform access for engine monitoring and user management |

---

## 3. Tier Structure

| Feature | Free | Pro ($40/mo) | All Sports ($65/mo) |
|:---|:---|:---|:---|
| NBA Live Props | 3 plays/day | Unlimited | Unlimited |
| NBA 2H Plays | Locked | Yes | Yes |
| NCAAB Live + 2H | No | Yes | Yes |
| MLB Live Signals | 2 games/day preview | Partial | Full |
| HR Radar | No | View Only | Full |
| Push Notifications | No | Yes | Yes |
| SMS Alerts | No | Yes | Yes (priority) |
| Parlay Builder | Partial | Full | Full |

All paid subscriptions include a 3-day free trial.

Stripe Price IDs:
- Pro: `price_1TJJ4M2ceUNmv10tYSsYXA6T` ($40/month)
- All Sports: `price_1TJJ4M2ceUNmv10tB8JCzPYe` ($65/month)

---

## 4. MLB Live Signal Engine (Primary Focus)

### 4.1 Supported Markets (real book lines only)

**Batter Markets:**
- Hits (hits)
- Total Bases (total_bases)
- Home Runs (home_runs)
- H+R+RBI (hrr)

**Pitcher Markets:**
- Strikeouts (pitcher_strikeouts)
- Outs Recorded (pitcher_outs)
- Hits Allowed (hits_allowed)
- Walks Allowed (walks_allowed)

**Excluded Markets (no bookmaker data available):**
- Batter Strikeouts (batter_strikeouts) — engine exists but no book data
- HR Allowed (pitcher_home_runs) — API key returns 422

### 4.2 Signal Pipeline

```
GAME DISCOVERY → DATA SYNC → FEATURE ENGINEERING → MARKET ENGINE → QUALIFICATION → NORMALIZATION → API → UI CARD
```

1. **Game Discovery** (every 5 min): ESPN API finds today's MLB games
2. **Pre-Hydration**: Pitcher season stats, weather, lineup fetched for new games
3. **Live Polling** (every 10s): Inning, score, lineup, pitch count, box score, contact data
4. **Feature Engineering**: 11 normalized scores per batter/pitcher matchup:
   - contactQuality, batSpeedPower, handednessMatchup, pitchBlendMatchup, hotColdForm, parkEnv, bvp, lineupOpportunity, bullpenFactor, pitcherSuppression, pitcherDeterioration
5. **Market Engine**: Distribution-based probability (Normal CDF, negative binomial, binomial) per market
6. **Phase 2.5 Enrichment**: Near-HR contact detection; pitch-mix × handedness multiplier; HR timing component; pitcher entry fatigue score (HR markets only)
7. **Qualification Gate**: Probability floor, edge validation, projection consistency, real odds check
8. **Normalization**: Flat signal with smart tags, primary reason, pitch matchup ratings, BvP history
9. **Confidence Tiers**: ELITE > STRONG > SOLID > LEAN > WATCHLIST
10. **Signal State Labels**: Conviction state (FIRE/READY/BUILD/WATCH) displayed in Action Feed and box score rows with live game and batter profile counts

### 4.3 Event-Driven Triggers
High-impact game events trigger immediate re-evaluation (5s dedup):
- new_ab, ab_completed, out_recorded, score_change, inning_change
- pitcher_change, tto_shift (times through order), lineup_substitution

### 4.4 Intelligence Layers

**Batter vs Pitcher (BvP):**
- Career matchup history fetched from MLB Stats API
- Score boost: .350+ avg → +15 signal score, <.200 → -10 penalty
- Displayed on signal cards: "8/22, .364, 3 HR"

**Batter vs Arsenal (Pitch Type Matchups):**
- Each pitch type rated independently using absolute thresholds
- Score ≥ 0.55 → batter favor (green ▲), ≤ 0.45 → pitcher favor (red ▼)
- Fastballs weighted by bat speed/power, breaking balls by pitch blend matchup, offspeed by contact quality
- Colors flip correctly for pitcher markets

**OnlyHomers.com Integration (self-learning data source):**
- Daily HR outcomes with full Statcast (EV, LA, distance, pitch type, pitcher, ballpark)
- Hot hitter detection: 7/14/30-day HR frequency → score boost (+0.8/+0.5/+0.3)
- Ballpark HR factors: 30 venues tracked with real season data
- Hourly scrape, 30-min in-memory cache

### 4.5 HR Radar System

**Canonical State Machine** (`hrRadarStateMachine.ts`):
9-state lifecycle — `inactive → watch → build → ready → fire → cashed|missed|model_review|expired`. Terminal states (`cashed`, `missed`, `model_review`, `expired`) are sticky and cannot be re-entered. Illegal transitions return `ok=false` and are logged, never thrown. In-memory persistence lives in `hrRadarCanonicalStore.ts`. Section/outcome helpers for the API layer live in `hrRadarSection.ts`.

**Near-HR Contact Detector** (`nearHrContact.ts`, Phase 2.5):
Pure function — no I/O, no probability mutation. Surfaces `watch|lean` tiers from per-AB contact data (EV/LA/distance/xBA/barrel flag). Supports `REPEATED_DANGER` pattern (multiple elevated-risk ABs). Callers log results under `[MLB_HR_NEAR_CONTACT_EVAL]` / `[MLB_HR_NEAR_CONTACT_MISSED_PATTERN]`.

**Contact Classification per at-bat (hrAlertEngine.ts):**
| Class | Thresholds |
|:---|:---|
| eliteHrContact | EV ≥ 102, LA 23-34°, dist ≥ 390 |
| hrShapedContact | EV ≥ 98, LA 20-38°, dist ≥ 360 |
| missedHrContact | HR trajectory that fell short |
| powerContact | Hard hit, suboptimal trajectory |
| noiseContact | Routine batted ball |

**Three Alert Paths (evaluateHRAlert.ts):**
- PATH_A: 2+ HR-shaped events + qualified EV mean ≥ 99 + max dist ≥ 375 + remaining PA ≥ 1.3
- PATH_B: 1 missed/elite HR + pitcher fatigue or favorable environment
- PATH_C: Late-game (inning 5+) with HR-shaped contact + favorable pitcher

**Negative Suppression:** Veto system for remaining PA, headwind, same-side matchup, cold temperature, repeat confirmation, LA consistency.

**Alert Tiers:** officialAlert, prepare, watch — with full diagnostics (alertPath, positiveFactors, suppressionFlags, pitcherFatigueState, environmentContext).

**Signal Gap Components** (added June 2026, `signalScore.ts` + `hrConversionModel.ts`):

| Component | Weight | Logic |
|:---|:---|:---|
| computePitchMixMatchupScore (Gap 1) | 12% in HR markets | Fastball-heavy opposite-side: +10%; same-side: +4%; breaking-heavy: −8%; offspeed-heavy: −5% |
| computeHrTimingComponent (Gap 2) | 8% in HR markets | Overdue (≥3× expected AB/HR rate): 90; recently hit: 35 |
| computePitcherEntryFatigueScore (Gap 3) | 5–8% in HR markets | Derived from last 3 pitcher starts (pitch count, days rest, ERA); max +30%/−10% conversion multiplier |

**Non-HR Signal State Engine** (`nonHrSignalState.ts`):
Mirrors HR Radar pattern for batter-over and pitcher markets: `BUILDING → ACTIVE → COOLING → CLOSED`. Terminal `CLOSED` state. `COOLING` fires when `signalScore` drops ≥ COOLING_DROP from peak. Daily slate-reset via `clearStaleNonHrStates`.

### 4.6 MLB Grading
- End-to-end grading using MLB Stats API boxscores
- ESPN event IDs resolved to MLB gamePk
- 14 markets mapped to boxscore fields
- Grading cron every 3 minutes
- Admin endpoints for manual trigger and grading summaries

---

## 5. NBA Engine

### 5.1 Probability Model
Distribution-based probability using Normal CDF with:
- Archetype-based variance multipliers and fragility scoring
- Calibration shrinkage (0.88 single stats, 0.78 combos)
- Safety ceilings per archetype

### 5.2 Player Archetypes (7)
stable_star, volatile_starter, bench_microwave, minutes_dependent, high_usage_volatile, low_usage_consistent, injury_risk

### 5.3 Features
- Market family grouping with derivative suppression
- Directional bias tracking with drift detection
- Combo market support (PTS+REB, PTS+AST, PRA) with covariance estimation
- Halftime 2H signals with live game context

### 5.4 Validation Harness
- Tests 55 engine constants, 8 archetype cases, 10 fixture scenarios
- CLI: `npx tsx server/validation/nba/run.ts`
- Admin endpoint: `GET /api/debug/nba/validate`
- Detects: ARCHETYPE_DRIFT, CALIBRATION_DRIFT, SAFETY_CEILING_DRIFT, etc.

---

## 6. NCAAB Engine

- Normal CDF model with deterministic edge rules
- Markets: Spreads, totals, team totals (full game, 1H, 2H)
- Qualified edge/fallback architecture
- Dynamic multiplier scaling with game progress
- Color-coded confidence tiers (ELITE, STRONG, LEAN)
- Live 2H context on halftime cards

---

## 7. User Interface

### 7.1 Pages

| Route | Page | Purpose |
|:---|:---|:---|
| `/` | Root Redirect | Redirects to `/dashboard` or `/landing` based on auth |
| `/landing` | Landing | Marketing with feature highlights, pricing, social proof |
| `/auth` | Auth | Login/registration with email verification |
| `/dashboard` | Dashboard | Primary view with sport tabs (NBA, MLB, NCAAB), live signals, top plays |
| `/ncaab` | NCAAB Live | Dedicated college basketball live tracking |
| `/analytics` | Analytics | Performance analytics and model accuracy |
| `/admin` | Admin | User management, engine diagnostics |
| `/performance` | Performance | Detailed model performance metrics |
| `/privacy` | Privacy | Privacy policy |
| `/terms` | Terms | Terms of service |
| `/verify-pending` | Verify Pending | Email verification status |
| `/reset-password` | Reset Password | Password recovery |

MLB Live is a sub-tab within the Dashboard, not a separate route.

### 7.2 MLB UI Architecture

**Three Sub-Tabs:**
1. **Games**: Horizontal game chip strip → two-panel game detail with signals
2. **Live Feed**: Top plays + tier-grouped live board
3. **HR Radar**: HR edges, hot hitter alerts, cashed/missed tracking

**Signal Card (MlbSignalCard):**
- Collapsed: Player name, market, side, probability ring, confidence tier, smart tag
- Expanded: Driver breakdown, pitcher arsenal matchup (bidirectional), BvP history, contact quality, at-bat log with pitch type colors, thesis, risk flags

### 7.3 Key Components

| Component | File | Purpose |
|:---|:---|:---|
| MlbSignalCard | `client/src/components/mlb/MlbSignalCard.tsx` | Unified MLB signal display |
| LiveBoard | `client/src/components/mlb/LiveBoard.tsx` | Tier-grouped signal board |
| MlbBoxScore | `client/src/components/mlb/MlbBoxScore.tsx` | Live box score with color-coded scanning |
| TopPlays | `client/src/components/mlb/TopPlays.tsx` | High-value signal carousel |
| SportSignalCard | `client/src/components/signals/SportSignalCard.tsx` | Cross-sport signal card |
| ParlaySlip | `client/src/components/parlay-slip.tsx` | Bottom sheet parlay builder |
| ProbabilityRing | `client/src/components/probability-ring.tsx` | Circular probability gauge |
| SportPicker | `client/src/components/sport-picker.tsx` | Sport selection toggle |

---

## 8. Data Architecture

### 8.1 Database (20 tables)

**User & System:** users, stripe_events, app_settings, feedback, signal_interactions

**NBA/NCAAB:** players, team_defense, parlay_picks, halftime_play_alerts, play_results, sent_alerts

**MLB:** contact_events, game_player_stats, hr_radar_alerts, hr_radar_analytics, hr_outcomes, hr_hot_hitters, hr_ballpark_factors

**Universal:** persisted_plays (60+ columns — central signal repository), persisted_alerts

### 8.2 External APIs

| Service | Purpose | Frequency |
|:---|:---|:---|
| MLB Stats API | Game state, box scores, play-by-play, BvP, pitcher stats | 10 seconds |
| ESPN API | Game discovery, roster sync, NBA/NCAAB data | 5 minutes |
| The Odds API | Live player prop odds (11 sportsbooks) | Per request |
| Baseball Savant | xBA, xSLG, bat speed, barrel rate | Per game |
| OnlyHomers.com | HR outcomes, hot hitters, ballpark factors | 60 minutes |
| Open-Meteo | Weather forecasts | 10 minutes |
| NBA Stats API | Usage rates, defensive matchups | Per game |
| RotoWire/Sleeper | Minutes projections | Daily |
| SGO | 1H lines, team total lines | Per request |

### 8.3 Supported Sportsbooks (11)
DraftKings, FanDuel, Hard Rock Bet, PrizePicks, Underdog Fantasy, BetMGM, BetRivers, ESPN BET, BetOnline, Bovada, William Hill US

---

## 9. API Routes

### Admin Routes (requireAdmin)

| Method | Path | Purpose |
|:---|:---|:---|
| GET | `/api/admin/users` | List all users |
| PATCH | `/api/admin/users/:id/tier` | Update user subscription tier |
| PATCH | `/api/admin/users/:id/reset-plays` | Reset play count |
| POST | `/api/admin/change-tier` | Change tier with Stripe integration |
| DELETE | `/api/admin/users/:id` | Delete user account |
| GET | `/api/admin/debug-user/:id` | Stripe/subscription debug info |
| GET | `/api/admin/nba-bias` | Current directional bias stats |
| GET | `/api/admin/roi` | Full ROI report |
| GET | `/api/admin/hr-radar-analytics` | HR alert conversion rates |
| POST | `/api/admin/onlyhomers/scrape` | Manual OnlyHomers scrape |
| GET/POST | `/api/admin/settings` | App settings management |
| GET | `/api/admin/feedback` | User feedback list |
| POST | `/api/admin/mlb/grade` | Manual MLB grading trigger |
| GET | `/api/admin/mlb/grading-summary` | MLB win/loss and ROI stats |

### MLB Routes

| Method | Path | Auth | Purpose |
|:---|:---|:---|:---|
| GET | `/api/mlb/live-games` | Auth | Live/scheduled MLB games with context |
| GET | `/api/mlb/live-stats/:gameId` | MLB Access | Live box score |
| GET | `/api/mlb/live-signals/:gameId` | MLB Access | Real-time signals for a game |
| GET | `/api/mlb/alerts` | Auth | Recent HR-build alerts |
| GET | `/api/mlb/hr-radar` | Auth | HR Radar board |
| GET | `/api/mlb/edge-feed` | Auth | Top edge signals across all games |
| POST | `/api/mlb/calculate` | MLB Access | Manual engine calculation |
| GET | `/api/mlb/onlyhomers/stats` | Auth | OnlyHomers hitter stats |
| GET | `/api/mlb/onlyhomers/hot-hitters` | Auth | Current hot hitters |
| GET | `/api/mlb/onlyhomers/batter/:name` | Auth | Batter HR history |
| GET | `/api/mlb/onlyhomers/bvp/:batter/:pitcher` | Auth | BvP HR matchup |

### NBA Routes

| Method | Path | Auth | Purpose |
|:---|:---|:---|:---|
| GET | `/api/top-plays` | Auth | Cross-sport top signals |
| GET | `/api/live-games` | Public | NBA scoreboard proxy |
| GET | `/api/live-stats/:gameId` | Public | NBA box score proxy |
| GET | `/api/halftime-plays` | Auth | NBA 2H plays |
| GET | `/api/odds` | Public | Live player prop odds |
| GET | `/api/game-lines` | Public | Spreads/totals |

### NCAAB Routes

| Method | Path | Auth | Purpose |
|:---|:---|:---|:---|
| GET | `/api/ncaab/plays` | Pro+ | NCAAB signals |
| GET | `/api/ncaab/live` | Pro+ | Live games with engine data |
| GET | `/api/ncaab/2h-lines` | Pro+ | 2H specific lines |

### User Routes

| Method | Path | Auth | Purpose |
|:---|:---|:---|:---|
| GET | `/api/me` | Auth | Current user profile with Stripe sync |
| POST | `/api/auth/register` | Public | Create account |
| POST | `/api/auth/login` | Public | JWT login |
| GET | `/api/user/alerts` | Auth | Alert settings |
| POST | `/api/user/alerts/sms` | Auth | Update SMS settings |
| POST | `/api/feedback` | Auth | Submit feedback |

---

## 10. Notifications

| Channel | Trigger | Tier |
|:---|:---|:---|
| Web Push (VAPID) | ELITE-tier signals, HR alerts | Free+ |
| SMS (Twilio) | ELITE-tier signals | Pro+ |
| Email (Resend) | Welcome, walkthrough, day-3, win-back, wall-hit, pro welcome | All |

---

## 11. Performance Requirements

| Metric | Target |
|:---|:---|
| Signal latency (game event → UI) | < 15 seconds |
| Live game polling | 10 seconds |
| Weather refresh | 10 minutes |
| OnlyHomers scrape | 60 minutes |
| Game discovery | 5 minutes |
| Edge cache TTL | 6 hours |
| Signal freshness gate | 10 minutes |
| Max concurrent games | 50 |

---

## 12. Quality Gates

### Signal Qualification:
- Valid recommended side (OVER or UNDER)
- Valid book line (finite, positive)
- Valid probabilities (both > 0)
- Not suppressed by engine
- Side probability ≥ market floor (typically 60%)
- Real odds hydration check
- HR UNDER always suppressed
- Projection consistent with side
- Signal score ≥ 55

### Engine Integrity:
- Probability ceiling per archetype
- Directional bias tracking with drift detection
- Market family suppression (no derivative spam)
- Two-AB rule for live form boosts
- Firewall for side/projection tension
- No synthetic/default book lines

---

## 13. Deployment

- **Platform**: Replit (cloud deployment)
- **Runtime**: Node.js + TypeScript (tsx)
- **Database**: PostgreSQL with Drizzle ORM
- **Frontend**: React + Vite + Tailwind + shadcn/ui
- **PWA**: Service worker with skipWaiting, network-first
- **Routing**: wouter (frontend), Express (backend)
- **Scheduled Jobs**: Orchestrator interval timers (not external cron)
