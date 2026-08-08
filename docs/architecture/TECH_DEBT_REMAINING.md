# LiveLocks Tech Debt Remaining

**Status:** written at the close of the "Risk-Ranked Repository Convergence" cleanup branch (`claude/livelocks-codebase-refactor-ejcs3w`, based on HEAD `43f6e3a`). Everything below was found during that pass's reconnaissance and deliberately **not** touched, per the governing rule: *when uncertain, preserve, document, queue — don't guess.*

## 1. Purpose / how items graduate off this list

Each item below carries the risk classification it was assigned during the cleanup audit:

- **SAFE-A / SAFE-B** items that ended up here were deprioritized for time, not risk — they're candidates for the next cleanup pass with no new investigation needed.
- **RISK-C** items need a proposed design + explicit equivalence proof before touching.
- **BLOCKED-D** items are engine/model-behavior-adjacent or require new infrastructure (not cleanup) — they need a dedicated, scoped pass of their own, likely with product sign-off.

An item graduates off this list when it's implemented in a follow-up branch and the corresponding row is deleted (not just marked done).

---

## 2. God-file restructuring backlog (BLOCKED-D — no test harness)

| File | Lines | Suggested future extraction seams |
|---|---|---|
| `server/routes.ts` | ~11,100 | By domain family, matching CLAUDE.md's route groupings: MLB routes, NBA routes, NCAAB routes, admin routes, billing/Stripe routes, analytics routes (some already factored into `registerPlaysRoutes`/`registerPerformanceRoutes`/`registerCalibrationRoutes`/`registerAnalyticsRoutes` functions at the bottom of the same file — a real precedent to extend). `routes.ts` should end as an orchestration/registration file only. |
| `server/storage.ts` | ~8,940 | By domain, matching `IStorage`'s natural groupings: `userStorage`/`subscriptionStorage`/`playStorage`/`gradingStorage`/`mlbStorage` (further split by MLB subsystem — Pregame Power Radar, Mound Radar, Plate HR V2, episodes/lane predictions, calibration). Keep the existing `storage` facade delegating to the split modules during migration; callers don't need to migrate in the same PR. |
| `server/mlb/liveGameOrchestrator.ts` | ~6,250 | Game discovery / live polling / state-change detection / engine-triggering / HR-play grading are five distinguishable responsibilities currently in one file. |
| `client/src/components/ncaab-admin-tab.tsx` | ~4,920 | Blocked on §8 below — decomposing the component without first moving its business logic server-side just moves the ownership problem into smaller files. |
| `client/src/pages/dashboard.tsx` | ~4,570 | Multi-sport signal feeds / onboarding / injuries / live plays / query-param handling look separable once characterization tests exist. |

**Prerequisite for all five:** characterization tests capturing current approved observable behavior, since there is no CI/test runner in this repo (tests are ~130 standalone `.test.ts` files run individually via `npx tsx`). Extract-only refactoring — preserve exact HTTP paths, middleware ordering, response shapes, error behavior, and authorization; run focused tests + global typecheck/build after each extraction.

---

## 3. Legacy LiveSignalBus bypass routes (BLOCKED-D)

5 routes (`GET /api/mlb/live-games`, `/live-signals/:gameId`, `/boxscore-engine-state/:gameId`, `/hr-radar-analyze/:playerId/:gameId`, `/debug`) read live MLB state outside the canonical ENGINE→NORMALIZER→LiveSignalBus flow — confirmed via the codebase's own `markLegacyConsumer()` self-instrumentation, not a guess. Each now carries a `// LEGACY BYPASS` banner comment (added in this pass) pointing at `CANONICAL_SYSTEM_MAP.md` §10.

**Why not touched:** these are large (300–1200+ line), live, production-serving handlers. Migrating them to route through LiveSignalBus is a real behavior change to how live signal state is served — needs its own dedicated pass with a test harness, not folded into a structure-only cleanup.

**Migration sketch for the future pass:** for each route, identify what canonical-signal read it's actually trying to serve, confirm an equivalent LiveSignalBus/lifecycle-store read exists or can be added, prove output parity on a sample of live traffic, then migrate one route at a time (each its own commit, each re-verified against the specific route before/after).

---

## 4. Two admin tier-mutation endpoints (RISK-C)

`PATCH /api/admin/users/:id/tier` (bare write) vs `POST /api/admin/change-tier` (also cancels Stripe subscriptions + resets play counters) have different, non-overlapping side effects. This pass added a cross-referencing comment at each call site (landmine warning) but did **not** merge or remove either — guessing which callers need which side-effect set risks silently breaking billing/entitlement flows.

**Open question for an owner:** should the bare `PATCH` endpoint be removed entirely (forcing all tier changes through the Stripe-aware path), or is there a legitimate reason to bypass Stripe cleanup (e.g. syncing a tier that was already changed in Stripe directly)? Needs a product/billing-owner decision, not a code-level guess.

---

## 5. Freshness-checker consolidation (RISK-C)

5 independent freshness-checking implementations exist (see `CANONICAL_SYSTEM_MAP.md` §6 for the full table): the canonical `isMLBSnapshotFresh`, two independently-defined generic `isFresh(entry,ttl)` cache helpers (`oddsService.ts`, `ncaabService.ts`), a third independent MLB-only `isFresh(timestamp)` in `mlb/markets.ts` (used by `canShowSignal()`, doesn't reference the canonical gate at all), and `classifyFreshness()` in `odds/oddsConfig.ts` with its own hardcoded threshold table. (A sixth, zero-caller `isFreshFromCache()`, was deleted in this pass.)

**Why not touched:** not yet numerically drifted, but each has different semantics/callers. Combining requires proving every call site tolerates identical thresholds — a live-odds-gating behavior change across 3 sports, not a structural move.

**Proposed target design for a future pass:** one canonical `isFresh(sport, gameStatus, isLive, ageMs)` function backing all cache-TTL and business-logic freshness checks, with `mlb/markets.ts`'s independent 120s window either justified in a comment (if intentionally different) or folded in. Needs a before/after audit of every call site's actual threshold behavior first.

---

## 6. Bookmaker allowlist consolidation (RISK-C)

4 remaining independent bookmaker lists after this pass removed `SUPPORTED_BOOKS` (which lived inside the deleted `sportsbookService.ts`): `MLB_PROP_BOOKMAKERS`, `PROP_BOOKMAKERS`, `PREFERRED_BOOKS_BY_SPORT`/`FALLBACK_BOOKS_BY_SPORT`, `APPROVED_BOOKS`. See `CANONICAL_SYSTEM_MAP.md` §7 for the full table.

**Why not touched:** `APPROVED_BOOKS` mixes casing (`"draftkings"` vs `"DraftKings"`) and short codes (`"dk"`/`"fd"`/`"hr"`/`"mgm"`) not present in any other list — a single-source refactor needs a casing/code-scheme decision that's product-adjacent (which display label wins?), not mechanical.

**Proposed target design:** one canonical per-sport book-identity list (lowercase, full names, single source), with `PREFERRED_BOOKS_BY_SPORT` becoming a pure ranking/ordering view over it rather than a separately-maintained list.

---

## 7. NCAAB shared-contract gap (BLOCKED-D — feature work, not cleanup)

NCAAB has zero `shared/` contract presence, unlike MLB's ~20 files (see `CANONICAL_SYSTEM_MAP.md` §5). This is the structural root cause of §8 below.

**Scope estimate for a future pass:** define `shared/ncaabSignal.ts` (or similar) carrying at minimum a server-stamped `displaySide`/`impliedOdds`/`confidenceTier` for whatever markets currently derive these client-side; stamp them server-side (likely in `ncaabService.ts`/`ncaabEngine.ts`); migrate `ncaab-admin-tab.tsx` to read them verbatim. This is genuinely new infrastructure work, not a mechanical extraction — needs its own scoping pass.

---

## 8. NCAAB client-side Hard-Rule-4 violations (BLOCKED-D — blocked on §7)

`client/src/components/ncaab-admin-tab.tsx` computes, entirely client-side:
- American odds from probability (implied-odds formula), 4 call sites.
- Confidence tier from raw probability thresholds, 3+ functions (`getPreGameConfidenceTier`, `getChipColorTier`, `getTeamTotalVerdict`).
- A bespoke "sharp money" signal synthesized from spread vs. ESPN win% (`detectSharpMoney`).

All feed directly into the live parlay-building UI. Fixing properly requires §7 (NCAAB growing its first shared canonical contract) first — cannot be fixed in isolation without either fabricating a contract ad hoc or leaving the fix half-done.

---

## 9. Path-convention outlier (RISK-C — breaking API change)

`GET /api/mlb/admin/hr-radar/coverage` nests `admin` under the sport instead of the universal `/api/admin/...` prefix used by the other 60+ admin routes. (The other outlier flagged during recon, `POST /api/ncaab/admin/cache-clear`, is **confirmed actively called** by `ncaab-admin-tab.tsx` with its literal path — renaming either needs an alias strategy, not a blind rename, since external/non-repo consumers can't be ruled out without server access logs.)

---

## 10. `GET /api/mlb/debug` vs `GET /api/debug/mlb` overlap (needs investigation)

Two "debug MLB" endpoints exist with different auth patterns (`requireAuth` + manual `isAdmin` check vs `requireAdmin`) and different content (live-game/edge-cache dump vs. `getEngineDebugSummary("mlb")` + `getMLBDiagnosticSummary()`). `/api/mlb/debug` is also one of the 5 legacy LiveSignalBus bypasses (§3). Needs an investigation ticket to determine intended scope of each before any merge decision.

---

## 11. `mlbNormalizers.ts` tier-collapse mapping — queued follow-up: **MLB Client Normalizer Contract Convergence**

`deriveBestPlay()`/`deriveAllPlayerPlays()` in `client/src/lib/mlb/mlbNormalizers.ts` ignore the already-available, reliably-populated, server-stamped `confidenceTier`/`signalTier` fields on their own input type (`SignalLike`) and instead re-derive a 3-bucket tier (`"monitor"|"building"|"strong"|null`) from raw `enginePct` thresholds (75/65/55) — inconsistent with the sibling function `deriveMlbRibbonChipSignal` in the same file, which correctly reads `signalTier` exclusively and documents that contract. This is a real server/client vocabulary mismatch: two functions in the same file disagree about which field is authoritative for tier.

Both `confidenceTier` (`server/mlb/normalizeSignal.ts:518`, always defaulted to `"WATCHLIST"`) and `signalTier` (derived via the canonical `deriveSignalTier()` in `server/mlb/signalScore.ts`) are confirmed non-sparse, reliable fields — this is not blocked on missing data.

**This branch characterizes but does NOT change production mapping behavior**, per the blast-radius ceiling (tier-semantic changes are explicitly out of scope — changing which field/threshold drives the tier shown on the live UI is a user-visible sorting/badge change). What this branch did instead:
- Made `SignalLike` exported (`client/src/lib/mlb/mlbNormalizers.ts`) — type-only, zero runtime effect — so it can be referenced from a test.
- Added a characterization suite (`client/src/lib/mlb/mlbNormalizers.test.ts`, section 7 — 11 new checks, run via `npx tsx client/src/lib/mlb/mlbNormalizers.test.ts`) that pins the CURRENT enginePct-threshold behavior of both functions, including the explicit gap: a signal with `confidenceTier: "ELITE"` but low `enginePct` currently returns `confidenceTier: null` (server tier is silently ignored). This is a regression guard, not a fix — it exists so the follow-up branch has a precise, automated before/after diff and so nothing else accidentally changes this mapping in the meantime.

**Proposed mapping for the follow-up branch (unapplied here):** prefer `signalTier`/`confidenceTier` when present, mapped `elite→strong, strong→strong, lean→building, watch→monitor`, falling back to the existing `enginePct`-threshold heuristic only when the field is absent (matching this file's own established cache-rollover fallback pattern elsewhere, e.g. `deriveMlbRibbonChipSignal`'s own cache-rollover branch). Verification path for that branch: update section 7's characterization assertions to the new expected mapping (they will fail against the old behavior by design, proving the change), plus a parity comparison against a snapshot of real cached signal payloads before merging, since this changes live-UI sort/badge output.

---

## 12. Script directory consolidation (naming/ownership convention TBD)

Three script directories (`scripts/`, `script/`, `server/scripts/`) serve genuinely different purposes (see `CANONICAL_SYSTEM_MAP.md` §11) — not true duplication. The one real oddity is `script/`'s singular name holding a single file (`build.ts`) that's directly wired into `npm run build`. A rename/merge into `scripts/build.ts` is low-risk in principle but touches the deploy-critical build command and (per CLAUDE.md Hard Rule 7) any accompanying `package.json` script-path edit needs strong cause — deferred rather than risked in a structure-only pass.

---

## 13. NCAAB 4-file relocation into `server/ncaab/` (deferred pure-move)

`ncaabEngine.ts`, `ncaabService.ts`, `ncaabEnrichment.ts`, `ncaabDiagnostics.ts` sit loose at `server/` top level, unlike MLB/NBA's namespaced directories. Architecturally correct eventually, but a pure-move refactor with nonzero diff size (import path updates across every consumer) for zero behavior gain relative to other priorities in this pass. Its own future pass, with a full `npx tsc --noEmit` + `server/ncaabEngine.test.ts` (and any other NCAAB regression coverage) gate.

---

## 14. `GET /api/admin/mlb-live-debug` outright removal (candidate, not yet actionable)

This pass deduplicated the route's field-mapping logic against its superset sibling `GET /api/admin/live-debug` (extract, don't delete — see `CANONICAL_SYSTEM_MAP.md` §10 commit history) rather than removing it outright. Zero references were found anywhere in `client/src`, but that isn't proof of zero external consumer (no server access logs available in this environment). Candidate for outright removal in a future pass once external-consumer traffic can be confirmed some other way (e.g. a short deprecation-log period before deletion).

---

## 15. Remaining `/upgrade` hard-navigation instances (SAFE-B, not yet applied)

This pass fixed the one clear-cut `window.location.href = "/upgrade"` imperative assignment (`SportSignalCard.tsx`). Three more `<a href="/upgrade">` plain-anchor instances exist and were left untouched as a more debatable style choice (anchor tags are less clearly a Hard Rule violation than an imperative `window.location` assignment):

- `client/src/components/mlb/LiveFeed.tsx:327`
- `client/src/pages/mlb-live.tsx:1084`
- `client/src/pages/mlb-live.tsx:1136`

Same fix pattern applies (wouter `navigate`/`Link` instead of anchor tag) if a future pass wants full consistency.

---

## 16. `server/mlb/dataSources.ts` UTC-vs-ET query boundary — **BLOCKED-D FOR THIS BRANCH / MLB CORRECTNESS FIX FOR FOLLOW-UP**

Per the charter's blast-radius ceiling, this item feeds probability-relevant MLB systems and is explicitly **not modified on this branch**. It is characterized here only, for a dedicated follow-up.

**Exact file/function:** `server/mlb/dataSources.ts`, function `fetchBaseballSavantData` (declared line 532). The UTC date is built at line 615:
```ts
const today = new Date().toISOString().split("T")[0];
```
used two lines later (617–618) as the `game_date_lt` upper bound in both the batter- and pitcher-side Baseball Savant Statcast CSV query URLs. (`seasonStart`, the lower bound at line 614, is a fixed `${currentYear}-01-01` and is not affected by this issue.)

**Current UTC behavior:** `new Date().toISOString()` renders the instant in UTC, so `today` is UTC's current calendar date. Between roughly 8:00 PM and midnight ET (UTC is 4–5 hours ahead of ET depending on DST), `today` has already rolled over to the *next* calendar date in UTC while it is still the prior date in US Eastern time. The CSV query's `game_date_lt` bound is therefore one day later than intended during that window, silently admitting one extra UTC-day of Statcast rows into the season aggregate.

**Expected `todayET()` behavior:** `server/utils/dateUtils.ts`'s `todayET()` (line 1) returns the current date already resolved to `America/New_York`, matching every other slate/window computation in the codebase (CLAUDE.md §3.4 / Hard Rule 9: "Do not use `new Date()` for slate/window logic — use `todayET()`"). Swapping line 615 to `const today = todayET();` would make the query's upper bound agree with the ET slate day the rest of the MLB pipeline already uses, eliminating the evening UTC/ET mismatch window.

**Downstream consumers** (direct callers of `fetchBaseballSavantData`, confirmed via repo-wide grep, `server/mlb/dataSources.ts` itself excluded):
- `server/mlb/pregame/mound/buildMlbMoundRadar.ts`
- `server/mlb/pregame/mound/contactRisk.ts`
- `server/mlb/dataPullService.ts`
- `server/mlb/pregamePowerRadar/buildPregamePowerRadar.ts`
- `server/mlb/pregamePowerRadar/hrProbabilityV2/plateHrV2SufficientStats.ts`

Each of these feeds season-aggregate Statcast inputs (xwOBA, ISO, pull rate, batted-ball mix, pitcher whiff/CSW, etc.) into pregame HR-probability and Mound Radar scoring — probability-relevant engine inputs, not display-only fields.

**Why it needs dedicated MLB regression verification (not a mechanical swap):** the fix is a one-line-touched-twice change, but its *effect* shifts which calendar day's row set is included in season aggregates that feed live probability computations for Mound Radar and Pregame Power Radar — this is an engine-input behavior change under CLAUDE.md §7a ("Sanctioned Engine Changes"), which requires: making the change in the engine-input layer (satisfied — `dataSources.ts` is upstream of the engine, not a composition/bus layer), confirming no payload-shape change, and — critically — **re-baselining the goldmaster** (`MLB_GOLDMASTER_VERSION` in `server/mlb/goldmasterGuard.ts`) plus running the Baseball-Savant-adjacent MLB regression suites (at minimum `pregamePowerRadar/plateChampionJul20Regression.test.ts`, `plateModelShadowIsolation.test.ts`, `isoAssessment.test.ts`, and the Mound Radar `contactRisk.test.ts`/`matchupAdjustedKs.test.ts`) before merge, since a champion-score/tier drift here would trip the plate-champion policy lock. That verification work is explicitly out of scope for a structure-only cleanup branch.

**Ready-to-apply fix for the follow-up branch:** swap `new Date().toISOString().split("T")[0]` for `todayET()` at line 615 (already available via `server/utils/dateUtils.ts`, imported elsewhere in the MLB codebase), then run the regression suites listed above and re-baseline the goldmaster per §7a.
