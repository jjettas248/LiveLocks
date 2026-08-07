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

## 11. `mlbNormalizers.ts` tier-collapse mapping (RISK-C, proposal ready — deferred, no go-ahead received this pass)

`deriveBestPlay()`/`deriveAllPlayerPlays()` in `client/src/lib/mlb/mlbNormalizers.ts` ignore the already-available, reliably-populated, server-stamped `confidenceTier`/`signalTier` fields on their own input type (`SignalLike`) and instead re-derive a 3-bucket tier (`"monitor"|"building"|"strong"|null`) from raw `enginePct` thresholds (75/65/55) — inconsistent with the sibling function `deriveMlbRibbonChipSignal` in the same file, which correctly reads `signalTier` exclusively and documents that contract.

Both `confidenceTier` (`server/mlb/normalizeSignal.ts:518`, always defaulted to `"WATCHLIST"`) and `signalTier` (derived via the canonical `deriveSignalTier()` in `server/mlb/signalScore.ts`) are confirmed non-sparse, reliable fields — this is not blocked on missing data.

**Ready-to-apply proposed fix:** prefer `signalTier`/`confidenceTier` when present, mapped `elite→strong, strong→strong, lean→building, watch→monitor`, falling back to the existing `enginePct`-threshold heuristic only when the field is absent (matching this file's own established cache-rollover fallback pattern elsewhere). This was presented for a go-ahead during the cleanup pass and not confirmed in time — proposal stands ready for the next pass. Verification path: since no dedicated regression test exists for this file, write a throwaway parity script comparing old-vs-new tier assignment across a snapshot of real cached signal payloads before merging.

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

## 16. `server/mlb/dataSources.ts:615` UTC-vs-ET query boundary (RISK-C, proposal ready — deferred, no go-ahead received this pass)

`const today = new Date().toISOString().split("T")[0]` (UTC) is used as the `game_date_lt` upper bound for a Baseball Savant season-stats CSV pull, instead of `todayET()` like everywhere else in the codebase — a genuine Hard-Rule-4 violation (`CLAUDE.md` §4: "Do not use `new Date()` for slate/window logic"). Near ET midnight (~7–8pm ET), the query window can be one calendar day off from the intended ET slate day.

**Why not applied this pass:** `fetchBaseballSavantData()` (the containing function) feeds directly into `buildMlbMoundRadar.ts`, `contactRisk.ts`, `buildPregamePowerRadar.ts`, `pitchFamilyMatchup.ts`, `plateHrV2SufficientStats.ts`, and `batterPowerProfile.ts` — a direct input to HR-probability/Mound-radar engine computations. The fix is mechanical (swap in `todayET()`), but its effect shifts which calendar day's stat window feeds probability-relevant season aggregates, which crosses into BLOCKED-D territory by the charter's own definition even though the code change is one line touched twice.

**Ready-to-apply fix:** swap both occurrences of `new Date().toISOString().split("T")[0]` for `todayET()` (already imported/available via `server/utils/dateUtils.ts` elsewhere in the codebase). This was presented for a go-ahead during the cleanup pass and not confirmed in time — proposal stands ready for a future engine-adjacent pass, ideally paired with re-running whatever MLB regression suites exercise Baseball Savant-fed HR/Mound inputs.
