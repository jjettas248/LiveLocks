# LiveLocks Full-System Goldmaster Audit — 2026-04-25

Audit pass scoped to the 12-phase Goldmaster Stabilization spec.
Read-only investigation across Core Engine, Conversion, UX, Retention,
Growth, Analytics. Findings are observational unless explicitly noted
"FIX SHIPPED THIS PASS".

Scope of fixes shipped this pass (additive only):

- **PASS A** (commit `08a853f`) — Hide legacy global "Live Signals" panel
  from standard paid users (admin diagnostic surface preserved); add
  `diagnostics` block to `/api/mlb/hr-radar/ladder` empty-state response.
- **PASS B** (this commit) — Emit `[HR_RADAR_CACHE_UPDATE]` log when
  `dedupeHrRadarRecords` actually drops a duplicate. Closes the only
  open hole in the prior HR Radar Master Fix (T007).

No engine math, schema, NBA, NCAAB, billing, gating, or grading code is
touched in this pass.

---

## Phase 1 — Full app health check

### Section A — Route catalog

| Path | Method | Auth | Status | Notes |
|---|---|---|---|---|
| `/api/auth/register` | POST | None | OK | Turnstile + disposable email check |
| `/api/auth/login` | POST | None | OK | email/phone |
| `/api/auth/logout` | POST | None | OK | session destroy |
| `/api/auth/me` | GET | `requireAuth` | OK | server/auth.ts; includes 5-min Stripe backstop |
| `/api/me` | GET | `requireAuth` | OK | server/routes.ts ~3695 |
| `/api/auth/verify-email` | GET | None | OK | email verification |
| `/api/user/alerts` | GET | `requireAuth` | OK | alert prefs |
| `/api/user/alerts/push-subscription` | POST | `requireAuth` | OK | VAPID push |
| `/api/user/complete-onboarding` | POST | `requireAuth` | OK | walkthrough done flag |
| `/api/ncaab/plays` | GET | `requireTier` | OK | live signals + timing gate |
| `/api/ncaab/games` | GET | `requireTier` | OK | scoreboard |
| `/api/ncaab/live` | GET | `requireTier` | OK | full live package |
| `/api/ncaab/h2h` | GET | `requireTier` | OK | head-to-head |
| `/api/ncaab/2h-lines` | GET | `requireTier` | OK | 2H lines |
| `/api/mlb/live-games` | GET | `requireAuth` | OK | spec called this `/api/mlb/games` — wired under `/live-games` |
| `/api/mlb/hr-radar` | GET | `requireAuth` | OK | live HR feed; row-level fixup applied |
| `/api/mlb/hr-radar/ladder` | GET | `requireAuth` | OK | decision ladder (5 sections); diagnostics block added |
| `/api/mlb/hr-radar-board` | GET | `requireAuth` | OK | full board; fixup + dedupe applied |
| `/api/mlb/hr-radar-grading-history` | GET | `requireAuth` | OK | 1–30 day window |
| `/api/mlb/hr-radar-grading/:sessionDate` | GET | `requireAuth` | OK | per-day canonical |
| `/api/mlb/hr-radar-analyze/:playerId/:gameId` | GET | `requireAuth` | OK | per-player drilldown |
| `/api/mlb/edge-feed` | GET | `requireAuth` | OK | TODO: rename to `/signal-feed` (low priority) |
| `/api/mlb/live-signals/:gameId` | GET | `requireMLBAccess` | OK | per-game detailed |
| `/api/mlb/live-stats/:gameId` | GET | `requireMLBAccess` | OK | spec called this `/api/mlb/live-boxscore` — wired under `/live-stats/:gameId` |
| `/api/mlb/props` | POST | `requireMLBAccess` | OK | prop probability calc |
| `/api/halftime-plays` | GET | per-row gating | OK | NBA 2H plays — spec called this `/api/nba/live` |
| `/api/halftime-plays/verify-client` | POST | `requireAuth` | OK | client-side reconciliation |
| `/api/admin/users` | GET | `requireAdmin` | OK | |
| `/api/admin/users/:id/tier` | PATCH | `requireAdmin` | OK | |
| `/api/admin/lifecycle-metrics` | GET | `requireAdmin` | OK | trial/conversion/churn |
| `/api/admin/roi` | GET | `requireAdmin` | OK | financial |
| `/api/admin/odds-health` | GET | `requireAdmin` | OK | API key/cache status |
| `/api/admin/rail-analytics` | GET | `requireAdmin` | OK | UI rail analytics |
| `/api/admin/hr-radar-analytics` | GET | `requireAdmin` | OK | HR radar analytics |
| `/api/mlb/admin/hr-radar/coverage` | GET | `requireAdmin` | OK | detection coverage metrics |
| `/api/performance` | GET | `requireAdmin` | OK | model performance dashboard |
| `/api/analytics/summary` | GET | `requireAdmin` | OK | analytics summary |
| `/api/analytics/nba-audit` | GET | `requireAdmin` | OK | NBA audit |
| `/api/debug/nba` | GET | `requireAdmin` | OK | NBA engine diagnostics |
| `/api/mlb/diagnostics` | GET | `requireAdmin` | OK | |
| `/api/mlb/market-report` | GET | `requireAdmin` | OK | |
| `/api/mlb/self-learning-status` | GET | `requireAdmin` | OK | |
| `/api/admin/test-alert` | POST | `requireAdmin` | OK | |
| `/api/admin/mlb/grade` | POST | `requireAdmin` | OK | |

**Spec route name → actual route name reconciliation:**

| Spec name | Actual route | Status |
|---|---|---|
| `GET /api/mlb/games` | `GET /api/mlb/live-games` | semantic alias only — same data |
| `GET /api/mlb/live-boxscore` | `GET /api/mlb/live-stats/:gameId` | per-game; same data |
| `GET /api/nba/live` | `GET /api/halftime-plays` | NBA UI consumes this; no separate `/api/nba/live` exists |
| `GET /api/admin/analytics` | `GET /api/analytics/summary` (admin-gated) | semantic alias |
| `GET /api/admin/model-performance` | `GET /api/performance` (requireAdmin) | semantic alias |

### Section B — Pages catalog

| Route in `App.tsx` | File | Status |
|---|---|---|
| `/` (root) | `client/src/pages/landing.tsx` (via `RootRedirect`) | OK |
| `/landing` | `client/src/pages/landing.tsx` | OK |
| `/auth` | `client/src/pages/auth.tsx` | OK |
| `/dashboard` | `client/src/pages/dashboard.tsx` | OK — primary surface |
| `/admin` | `client/src/pages/admin.tsx` | OK — gated |
| `/analytics` | redirects to `/admin` | OK |
| `/performance` | redirects to `/admin` | OK |
| `/ncaab` | `client/src/pages/ncaab-live.tsx` | OK — standalone page |
| `/privacy` | `client/src/pages/privacy.tsx` | OK |
| `/terms` | `client/src/pages/terms.tsx` | OK |
| `/verify-pending` | `client/src/pages/verify-pending.tsx` | OK |
| `/reset-password` | `client/src/pages/reset-password.tsx` | OK |
| (none) | `client/src/pages/mlb-live.tsx` | **Embedded as a tab inside `dashboard.tsx`** — not routed standalone (intentional; mlb tab uses `MlbLivePage activeSubTab={mlbSubTab}` at dashboard.tsx ~4356). Not dead code. |
| (n/a) | `client/src/pages/nba-live.tsx` | **Does not exist**. NBA renders inside the dashboard "Calculator → Halftime" subtab. Not a regression — the system never had a standalone NBA page. |

### Section C — Recent runtime errors (server logs)

Searched current `/tmp/logs/` and `/tmp/lsp_logs/`:

- **Application runtime:** No critical errors observed. No "Cannot find
  module", no "is not a function" patterns, no `TypeError` from
  application code in the active log buffer.
- **LSP buffer:** ~15 "ERROR" entries — all environment/JSON-RPC
  metadata, not application runtime.
- **HR Radar specific:** `[HR_RADAR_HR_EVENT_DETECTED]`,
  `[HR_RADAR_BOXSCORE_HR_FALLBACK]`, `[HR_RADAR_RECONCILE_TICK]`,
  `[HR_RADAR_RECONCILE_GAME]`, `[HR_RADAR_INTEGRITY_FIXUP]` are all
  emitted as expected. After this pass, `[HR_RADAR_CACHE_UPDATE]` will
  also emit when duplicates are dropped.
- **NBA specific:** `[GAME_STATE_AUDIT]`, `[HALFTIME_DETECTION_RESULT]`,
  `[NBA_HT_LINE_TRACE]`, `[NBA_HT_PERSIST]` — all firing on cycle.
- **NCAAB specific:** `[ENGINE START][NCAAB]`, `[PIPELINE][NCAAB]`,
  `[NCAAB_HALFTIME_ENGINE]` — all firing on cycle. `[NCAAB FAILURE]
  zero markets` flag is in place for empty-market guardrail.

### Section D — Observed friction (no fixes shipped this pass)

| Area | Observation | Severity | Action taken |
|---|---|---|---|
| Spec route names | Spec lists e.g. `/api/mlb/games`; actual is `/api/mlb/live-games`. UI consumes the actual name correctly. | low | documented above; no rename (would break clients) |
| `mlb-live.tsx` | File exists but is not in `App.tsx`'s route table. | low | confirmed embedded as `<MlbLivePage activeSubTab>` inside dashboard tabs — intentional |
| `/api/mlb/edge-feed` | TODO comment says rename to `/api/mlb/signal-feed` | low | left alone (rename = breaking change without UI update) |

---

## Phase 2 — Legacy global signal surfaces

**FIX SHIPPED PRIOR PASS** (commit `08a853f` and `9654995`).

`TopPlaysPanel` (the cross-sport "Top Picks" / "Live Signals" surface)
in `client/src/pages/dashboard.tsx` ~line 2236 is now gated:

```ts
const SHOW_LEGACY_GLOBAL_SIGNALS =
  import.meta.env.VITE_SHOW_LEGACY_GLOBAL_SIGNALS === "true" ||
  !!user?.isAdmin;
if (!SHOW_LEGACY_GLOBAL_SIGNALS) {
  return <PublicProofStrip />;
}
return <TopPlaysPanel ... />;
```

Effect:

- Standard paid users (Pro / All Sports / Elite) see `PublicProofStrip`
  on the same surface where the legacy panel previously rendered. The
  cross-sport drawer is hidden.
- Admin users continue to see `TopPlaysPanel` as a diagnostic surface.
- Env override `VITE_SHOW_LEGACY_GLOBAL_SIGNALS=true` re-enables the
  legacy panel in any environment if needed for debugging.
- Other surfaces (`UserStatusRail` count badge, `LockedSignalModule`
  free-user CTA) are intentionally unchanged — they don't render the
  cross-sport signal cards the user complained about.

Sport-specific surfaces (NBA Live, MLB Live, NCAAB Live, MLB HR Radar)
are all preserved and unchanged.

---

## Phase 3 — Engine isolation

See `docs/engine-isolation-audit.md` (this commit).

**Verdict: ISOLATED.** No cross-sport imports between `server/mlb/`,
`server/nba*`, `server/ncaab*`. Each sport owns its own probability
phi/CDF, calibration, trigger/qualification, and archetype logic. Shared
code is limited to schema, dates, auth, persistence, and aggregation.

---

## Phase 4 — MLB HR Radar restore

**Status: VERIFIED WORKING.** No fixes required this pass.

- Route `/api/mlb/hr-radar/ladder` returns real data. Direct
  `getHrRadarLadder` probe for today's session 2026-04-25 returned:
  - `attackNow` (FIRE): 6
  - `ready`: 0
  - `building` (BUILD): 4
  - `watch` (TRACK): 74
  - `cashed`: 6
  - `dead`: 23
  - **Total: 113 candidates** for today.
- `diagnostics` block added in commit `9654995` exposes
  `{ sessionDate, rowsFound, liveGamesFound, fallbackRowsGenerated,
  source, generatedAt }`. `source` is one of `engine` |
  `engine_no_candidates` | `no_live_games` | `error`. Empty states are
  no longer silent.
- The route response key naming is `attackNow`/`building`/`watch` (DB
  canonical), not `fire`/`build`/`track` (UI label). The UI's
  `HrRadarLadder.tsx` `SECTION_META` correctly maps these to the FIRE /
  BUILD / TRACK display labels. Renaming server keys would break the
  client; no rename shipped.

**Spec point 4.3 (Track fallback rows from live box-score lineup):
SKIPPED.** Risk of phantom records grading incorrectly. The `diagnostics`
block now surfaces `engine_no_candidates` so the user sees an honest
empty state instead of silent zeros. Real data is flowing today, so the
need is theoretical.

---

## Phase 5 — HR Radar grading / detection ledger

**Status: VERIFIED WORKING.** No fixes required this pass.

### Lifecycle field mapping

The spec lists `firstTrackedAt`, `firstBuiltAt`, `firstReadyAt`,
`firstFireAt`, `hrOccurredAt`. These are **derived dynamically** in
`server/mlb/hrRadarUserStage.ts` (lines 357-367) from the persisted
columns:

| Spec field | Persisted column | Notes |
|---|---|---|
| `firstTrackedAt` / `firstTrackedInning` | `detectedAt` / `detectedInning` | engine first sighting |
| `firstBuiltAt` / `firstBuiltInning` | `signalDetectedAt` / `signalInning` | when row reached BUILD or higher |
| `firstReadyAt` / `firstReadyInning` | `signalDetectedAt` / `signalInning` | when row reached READY or higher |
| `firstFireAt` / `firstFireInning` | `signalDetectedAt` / `signalInning` | when row reached FIRE or higher |
| `hrOccurredAt` / `hrOccurredInning` | `hitDetectedAt` / `hitInning` | HR event |

`detectedAt` and `signalDetectedAt` are write-once (preserved on later
updates). The immutable ledger `hr_radar_signal_events` records every
state change (created, escalated, downgraded, cooled_off,
stage_transition, qualified_detected, resolved_*).

### Grading rule verification

Implemented in `server/storage.ts → matchHrRadarAlertToHrEvent` and
`server/validation/hrRadar/matchDecision.ts → decideHrRadarMatch`:

| Outcome | Rule | Implemented? |
|---|---|---|
| `called_hit` | qualifying signal event before HR + crossed out of Watch | ✅ lines 108–124 |
| `late_signal` | alert exists but signalDetectedAt is after `hrEnd` | ✅ lines 148–161 |
| `early_hr_no_window` | HR happened in 1st inning with no signals yet | ✅ line 3070 |
| `uncalled_hr` | no alert row for player/game | ✅ line 3098 |
| `called_miss` | presence-only row that never qualified | ✅ line 88 |

Track and Build are correctly **not counted as official graded calls**.
Only Ready and Fire qualify a row for `called_hit`.

---

## Phase 6 — NBA Live + 2H Plays

**Status: VERIFIED WORKING.** No fixes required this pass.

- Route: `/api/halftime-plays` (server/routes.ts ~4904).
- Halftime detection in `isNbaHalftimeWindow` (server/routes.ts ~4942)
  uses a 3-phase check:
  - `explicitHalftime` — status description contains "half".
  - `endSecondQuarter` — period 2 with clock ≤ 15s.
  - **Early Q3 grace** — period 3 with clock ≥ 600s (first 2 minutes).
- Line fallback in `deriveSecondHalfLine` (server/routes.ts ~4985)
  marks degraded data with `lineSource: "derived_2h_fallback"` and
  `isDegraded: true`.
- Frontend: `client/src/pages/dashboard.tsx` ~912 (Calculator tab,
  `nbaSubTab === "halftime"`). Refetches every 15s.
- Logs `[GAME_STATE_AUDIT]`, `[HALFTIME_DETECTION_RESULT]`,
  `[NBA_HT_LINE_TRACE]`, `[NBA_HT_PERSIST]` all firing.

NBA engine math is **not touched** in this pass.

---

## Phase 7 — NCAAB

**Status: VERIFIED WORKING.** No fixes required this pass.

- Routes: `/api/ncaab/plays`, `/api/ncaab/games`, `/api/ncaab/live`,
  `/api/ncaab/h2h`, `/api/ncaab/2h-lines`.
- Engine: `server/ncaabEngine.ts` (1218–1291 fallback logic).
- Fallback mechanism intact:
  - Markets with edge < 12% are marked `mkt.fallback = true` and
    `mkt.qualifiedEdge = false`.
  - Derived totals (no book line) marked `liveTotalSource: "derived"`
    with edge dampened by 35% (multiplier 0.65).
- Frontend: `client/src/pages/ncaab-live.tsx` (line 417 useQuery).
- Empty-market guardrail logs `[NCAAB FAILURE] zero markets`.

NCAAB fallback is **preserved and unchanged** in this pass.

---

## Phase 8 — Stripe / gating

**Status: VERIFIED WORKING.** No fixes required this pass.

### Effective tier resolution

- **Primary source:** `users.subscriptionTier` column.
- **Backstop:** `/api/auth/me` and `/api/me` both query Stripe directly
  on a 5-minute TTL when `stripeCustomerId` exists. If the DB tier
  drifts from Stripe (missed webhook), the DB is repaired in-flight.
- **Helpers:** `server/utils/access.ts → resolveAccess(tier, isAdmin)`
  returns `{ hasNBA, hasNCAAB, hasMLB, hasUnlimited }`. Frontend
  `client/src/lib/tierUtils.ts → hasProAccess(tier)` mirrors this.

### Per-tier gating

| Tier | Daily plays | NBA | NCAAB | MLB | Top Picks |
|---|---|---|---|---|---|
| Free | 3 plays/day total | gated by daily play | gated by daily play | gated by daily play | no |
| Pro / "all" | unlimited | ✅ | ✅ | ❌ | ✅ |
| Elite | unlimited | ✅ | ✅ | ✅ | ✅ |
| Admin | unlimited | ✅ | ✅ | ✅ | ✅ (as legacy diagnostic) |

- MLB preview limit (2/day) for non-Elite users when MLB games qualify.
- Admin bypasses every gate (`if (user.isAdmin) return next();` in
  `requirePlayAccess`, `requireMLBAccess`, `requireTier`).

### Webhook → tier update

- `server/webhookHandlers.ts` handles `checkout.session.completed`,
  `invoice.payment_succeeded`,
  `customer.subscription.created/updated/deleted`.
- `syncSubscriptionToDb` resolves the price/product to a tier via
  `resolveTierFromSubscription` and updates the user.
- Race condition mitigated by the in-flight Stripe backstop in
  `/api/auth/me`.

### `/api/me` vs `/api/auth/me`

Both return the same `subscriptionTier`, the same `resolveAccess` flags,
and `isAdmin`. `/api/me` adds a duplicate `hasNcaabAccess` (camelCase
mirror of `hasNCAAB`) and `requiresRefresh`. The frontend `useAuth`
hook reads `/api/auth/me` and refetches on window focus + reconnect
(`staleTime: 0`). Stale tier state should not occur.

---

## Phase 9 — Persistence + grading + analytics

**Status: VERIFIED WORKING.** No fixes required this pass.

### `persisted_plays` schema

All required columns present:

| Spec field | DB column |
|---|---|
| sport | `sport` (default 'nba') |
| player | `player_id` + `player_name` |
| market | `market` |
| line | `line` |
| odds | `odds` |
| projection | `projection` |
| probability | `prob`, plus `engine_prob`, `book_implied`, `raw_prob_*`, `final_prob_*` |
| edge | `edge_gap`, plus `model_edge` |
| timestamp | `created_at`, `timestamp` |
| status | `result` (hit / miss / push) |

Plus diagnostic columns: `settled_at`, `final_stat`, `sportsbook`,
`confidence_tier`, MLB-specific (`inning`, `ab_number`,
`contact_quality_score`, etc.).

### Persistence write paths

- **MLB:** `server/mlb/liveGameOrchestrator.ts` filters
  `qualifiedSignals` and writes via `trackPlay → storage.recordPlay`.
- **NBA Live + Halftime:** Inline in `server/routes.ts` engine + halftime
  routes. Halftime also writes to ledger via `storage.savePlayAlerts`.
- **NCAAB:** Inline in `server/routes.ts` engine route.
- **HR Radar Ready/Fire:** Persisted via `trackPlay` if score ≥ 55
  (qualified threshold). Lower-tier "Watch" rows live only in
  `hr_radar_alerts` (correctly excluded from official ROI).

### Grading

`server/services/gradePersistedPlays.ts`:

- Pending rows have `result = NULL`.
- MLB: fetches official MLB Stats API boxscore, compares `finalStat`
  vs line.
- NBA / NCAAB: fetches ESPN boxscore, aggregates required stat
  (e.g. `pts_reb_ast`).
- `storage.settlePlay` sets `result`, `final_stat`, `settled_at`.

### Analytics

`server/services/publicAnalyticsService.ts`:

- Filters `result IS NOT NULL` — pending plays are **excluded** from
  ROI / win rate.
- ROI formula: `((wins * 0.909 - losses) / decidedPlays) * 100` (-110
  juice equivalent).

### Coverage gaps (acknowledged, not fixed this pass)

- `trackPlay` rejects rows missing a `sportsbook` name. Any signal that
  qualifies but lacks a book is silently not persisted. Log
  `[PERSIST_REJECTED] reason=no_sportsbook` exists but is not currently
  surfaced as a metric.

---

## Phase 10 — Admin-only Performance

**Status: VERIFIED WORKING.** No fixes required this pass.

All `/api/admin/*` and analytics/performance routes are gated by
`requireAdmin` middleware:

`/api/admin/users`, `/api/admin/users/:id/tier`,
`/api/admin/users/:id` (DELETE), `/api/admin/debug-user/:id`,
`/api/admin/lifecycle-metrics`, `/api/admin/roi`,
`/api/admin/odds-health`, `/api/admin/rail-analytics`,
`/api/admin/hr-radar-analytics`, `/api/admin/settings`,
`/api/admin/test-alert`, `/api/admin/mlb/grade`,
`/api/mlb/admin/hr-radar/coverage`, `/api/performance`,
`/api/analytics/summary`, `/api/analytics/nba-audit`,
`/api/debug/nba`, `/api/mlb/diagnostics`, `/api/mlb/market-report`,
`/api/mlb/self-learning-status`.

Frontend gates:
- `App.tsx` `/admin`, `/analytics`, `/performance` redirect to `/` if
  `!user.isAdmin`.
- `client/src/pages/admin.tsx` page-level redirect.
- Component-level checks in `RecentResults`, `UserStatusRail`, admin
  tabs.

`useAuth` (`use-auth.ts`) is `staleTime: 0` + `refetchOnWindowFocus:
true` so admin status is fresh.

---

## Phase 11 — Route health

| Route | 200 valid | 401/403 unauth | No crash | Diagnostics on empty |
|---|---|---|---|---|
| `/api/auth/me` | ✅ | ✅ (401) | ✅ | n/a |
| `/api/me` | ✅ | ✅ (401) | ✅ | n/a |
| `/api/mlb/live-games` | ✅ | ✅ (401) | ✅ | returns `[]` |
| `/api/mlb/live-stats/:gameId` | ✅ | ✅ (401/403) | ✅ | returns null fields |
| `/api/mlb/hr-radar` | ✅ | ✅ (401) | ✅ | returns empty arrays |
| `/api/mlb/hr-radar/ladder` | ✅ | ✅ (401) | ✅ | ✅ `diagnostics` block (PASS A) |
| `/api/halftime-plays` | ✅ | ✅ (401) | ✅ | returns empty list |
| `/api/ncaab/live` | ✅ | ✅ (401/403) | ✅ | returns empty package |
| `/api/performance` | ✅ admin | ✅ (403 non-admin) | ✅ | returns zero-row payload |
| `/api/analytics/summary` | ✅ admin | ✅ (403 non-admin) | ✅ | returns zero-row payload |

Smoke probe of `/health` returned `{"ok":true}` post-restart.

---

## Phase 12 — Client render

| Surface | Loads on desktop | Loads on mobile | Empty state explained |
|---|---|---|---|
| `/dashboard` (root) | ✅ | ✅ | n/a |
| Dashboard NBA tab (Calculator → Halftime) | ✅ | ✅ | "no live halftime games" copy |
| Dashboard MLB tab → games subtab | ✅ | ✅ | "no MLB games right now" |
| Dashboard MLB tab → live_feed subtab | ✅ | ✅ | empty signal list |
| Dashboard MLB tab → hr_radar subtab | ✅ | ✅ | ✅ `diagnostics.source` (PASS A) |
| `/ncaab` | ✅ | ✅ | empty markets log |
| `/admin` (admin-only) | ✅ | ✅ | guarded |
| Legacy global Live Signals panel | hidden for non-admin | hidden for non-admin | n/a |

No infinite loaders observed. No "0 tracked" with players present (real
data flows; PASS A's diagnostics block exposes the reason if it
recurred). No raw debug text shown to users. No stale score scale
issues.

---

## Summary

**Health verdict: STABLE.**

Of the 12 phases, the prior `34268de` and `08a853f` commits already
shipped the meaningful behavioral fixes (legacy global panel hidden;
HR Radar diagnostics block; HR Radar dedupe wired; refetch interval;
canonical section/lifecycle helpers; ledger writes; reconcile loop;
event-based resolver). This pass adds the only missing diagnostic log
(`[HR_RADAR_CACHE_UPDATE]`) and produces the two required audit
documents.

Items deliberately skipped (per "if something might break, skip until
approved"):

- Track fallback rows synthesized from live box-score lineup (Phase 4
  point 3) — phantom-record grading risk.
- Renaming server response keys from `attackNow`/`building`/`watch` to
  `fire`/`build`/`track` (Phase 4 response shape) — would break the
  current UI which does the label mapping in `SECTION_META`.
- Renaming `/api/mlb/edge-feed` to `/api/mlb/signal-feed` — breaking
  change without UI update.
- Renaming `/api/mlb/live-games` to `/api/mlb/games` and
  `/api/mlb/live-stats/:gameId` to `/api/mlb/live-boxscore` — would
  break `mlb-live.tsx` and orchestrator clients.

Engine math, schema, NBA, NCAAB, billing, gating, and grading code are
unchanged in this pass.
