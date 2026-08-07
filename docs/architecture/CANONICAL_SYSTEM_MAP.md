# LiveLocks Canonical System Map

**Status:** reflects the repository as it exists after the "Risk-Ranked Repository Convergence" cleanup branch (commits on `claude/livelocks-codebase-refactor-ejcs3w`, based on HEAD `43f6e3a`). This is a "where is truth" index, not an aspirational redesign — for the authoritative description of the canonical signal pipeline and its hard rules, see `CLAUDE.md` §3 and §7, which this document defers to rather than duplicates.

---

## 1. Purpose and how to use this document

When you're not sure which of several similar-looking implementations is the one production actually depends on, start here. Each section below names the canonical implementation, its known legacy/parallel paths (if any), and points at `TECH_DEBT_REMAINING.md` for anything flagged but not yet resolved. This document is updated whenever a cleanup or convergence pass changes what's canonical — it is not meant to be a one-time snapshot.

---

## 2. Signal pipeline overview

```
ENGINE  →  NORMALIZER  →  LiveSignalBus  →  Lifecycle Store  →  UI / Alerts
                              ↑ sole ingress
```

Full description: `CLAUDE.md` §3.3. Key files: `server/services/liveSignalBus.ts` (sole ingress, `registerSignal`), `server/services/lifecycleStore.ts` + `lifecycleEngine.ts` (transitions only), `server/mlb/normalizeSignal.ts` (`applyDisplayContract`), `shared/canonicalSignal.ts` (`CanonicalSignal` transport contract).

**Self-instrumentation:** the bus tracks its own bypasses via `markLegacyConsumer(label)` (`liveSignalBus.ts`), incrementing a `legacyConsumers` counter and rate-limit-logging `[LL_LEGACY_SIGNAL_CONSUMER]`. See §10 for the 5 routes currently flagged this way.

---

## 3. Sport engine isolation map

| Sport | Location | Isolation status |
|---|---|---|
| MLB | `server/mlb/`, `server/engines/mlb/` | Clean — no cross-sport imports found; self-enforced by `server/mlb/phase3bRegression.test.ts` (scans touched files for `server/nba`/`server/ncaab` imports at test time) |
| NBA | `server/nba/` (flat, 8 files), `server/engines/nba*` | Clean — no cross-sport imports found |
| NCAAB | `server/ncaabEngine.ts`, `ncaabService.ts`, `ncaabEnrichment.ts`, `ncaabDiagnostics.ts` — **loose top-level files, no `server/ncaab/` namespace** | Clean isolation from other sports, but structurally inconsistent (see §5). Flagged in `TECH_DEBT_REMAINING.md`. |

`server/growth/` (HR Board Studio) imports into `server/mlb/` — this is a legitimate cross-cutting analytics domain, not a sibling sport module, and is not a Hard Rule violation.

---

## 4. MLB canonical contracts inventory (`shared/`)

MLB has ~20 dedicated shared contract files — by far the deepest canonical-contract coverage of the three sports. Key ones:

| File | Owns |
|---|---|
| `shared/mlbSignal.ts` | `MLBSignal` — the actual live display contract (`displaySide`, `displayProbability`, `displayGrade`, `isBettable`, `isWatchOnly`, `confidenceTier`, `signalTier`) |
| `shared/mlbCanonicalSignal.ts` | `CanonicalMlbSignal` — box-score-badge/calculator-panel specific shape |
| `shared/canonicalSignal.ts` | `CanonicalSignal` — cross-sport (mlb/nba/ncaab/nfl) transport contract, `LifecycleState`, `signalTier` |
| `shared/hrRadarStage.ts` | `CanonicalHrRadarStage` — HR Radar stage/badge vocabulary (track/build/ready/fire/resolved) |
| `shared/hrRadarDecisionView.ts` | Versioned "what should the UI show/allow" consumer decision contract for HR Radar |
| `shared/hrRadarConviction.ts` | Dual-engine disagreement display-cap layer |
| `shared/mlbCalibration.ts` | Stage C calibration artifact contract |
| `shared/mlbPredictionLedger.ts` | Stage B all-lane prediction ledger contract |
| `shared/mlbRecommendationEpisode.ts` | Frozen official-recommendation "episode" contract |
| `shared/mlbEmptyStateReason.ts` | Explicit empty-state reason codes (anti-fabrication) |
| `shared/mlbOddsProvenance.ts` | Odds freshness/provenance contract |
| `shared/normalizeMlbMarket.ts` | Canonical MLB market-key alias normalization |
| `shared/pregameRadarWin.ts`, `shared/moundRadarWin.ts` | Plate/Mound outcome-attribution contracts |
| `shared/mlbInningWindow.ts`, `shared/slateDate.ts`, `shared/dateLabel.ts` | Inning-bucket mapping, ET slate-day boundary math, display date formatting |

**Note:** `CanonicalSignal`, `CanonicalMlbSignal`, and `MLBSignal` are three deliberately-distinct vocabularies (each documents why it isn't reusing the others), not accidental duplication — confirmed during this cleanup pass.

---

## 5. NCAAB canonical-contract gap

**NCAAB has zero `shared/` presence.** Every NCAAB type (`NCAABMarketClient`, `MarketConfidenceTier`, `NCAABMarketKey`, `MarketSide`, `HandleSignal`, `ChipOddsData`, etc.) is declared locally inside `client/src/components/ncaab-admin-tab.tsx` — there is no shared canonical contract enforcing "read verbatim, don't re-derive" discipline for this sport the way MLB's ~20 files do.

This is the direct structural cause of the client-side Hard-Rule-4 violations documented in `TECH_DEBT_REMAINING.md` §8: with no server-stamped tier/odds field to read, `ncaab-admin-tab.tsx` computes American odds from probability, confidence tier from probability thresholds, and a bespoke "sharp money" signal — all client-side, feeding the live parlay UI.

Fixing this is architecture repair (building NCAAB's first canonical contract + moving decisioning server-side), not mechanical cleanup — explicitly out of scope for this pass.

---

## 6. Freshness-checking canonical map

| Implementation | Location | Scope | Status |
|---|---|---|---|
| `isMLBSnapshotFresh(gameStatus, ageMs)` | `server/oddsService.ts` | **Canonical MLB business-logic gate** — status-based, not TTL-based (pregame=2min, live=30s, final=immutable, unknown=cache-only) | Canonical |
| `classifyMlbOddsFreshness` | `server/odds/mlbOddsProvenanceContract.ts` | Wraps `isMLBSnapshotFresh` (test-verified never to disagree with it) | Canonical wrapper |
| `isFresh(entry, ttl)` | `server/oddsService.ts:169` | Private generic cache-TTL helper | Duplicate #1 (independently reimplemented) |
| `isFresh(entry, ttl)` | `server/ncaabService.ts:30` | Same shape, independently defined | Duplicate #2 |
| `isFresh(timestamp)` | `server/mlb/markets.ts:83` | A **third, independent** MLB freshness concept (hardcoded 120s window), used by `canShowSignal()` — does not reference `isMLBSnapshotFresh` | Independent MLB concept, not yet reconciled |
| `classifyFreshness(sport, isLive, ageMs)` | `server/odds/oddsConfig.ts` | Own hardcoded `FRESHNESS_BY_SPORT` table; ranking/annotation layer used by `odds/oddsSnapshot.ts` across MLB/NCAAB/Mound Radar | Currently numerically consistent with `isMLBSnapshotFresh`'s MLB thresholds, but hand-synced, no shared reference |

Consolidating these is a dedicated RISK-C follow-up — see `TECH_DEBT_REMAINING.md` §5. `isFreshFromCache()` (a fifth, zero-caller variant in `odds/oddsCache.ts`) was removed as confirmed-dead code in this pass.

---

## 7. Bookmaker allowlist canonical map

| List | Location | Scope |
|---|---|---|
| `MLB_PROP_BOOKMAKERS` / `_SET` | `server/oddsService.ts` | The real MLB request/gate filter (`draftkings,fanduel,hardrockbet`) |
| `PROP_BOOKMAKERS` / `_SET` | `server/oddsService.ts` | NBA/NCAAB gate (11 books) |
| `PREFERRED_BOOKS_BY_SPORT` / `FALLBACK_BOOKS_BY_SPORT` | `server/odds/oddsConfig.ts` | Ranking layer on top of the above — explicitly documented as needing to stay hand-synced |
| `APPROVED_BOOKS` | `server/oddsService.ts:1927` | Used only by `normalizeOdds()` — messiest list: mixed casing (`"draftkings"`/`"DraftKings"`), short codes (`"dk"`/`"fd"`/`"hr"`/`"mgm"`) not present elsewhere |

`SUPPORTED_BOOKS` (a fifth list, inside the now-deleted `services/sportsbookService.ts`) was removed with that module in this pass. Consolidating the remaining 4 is a dedicated RISK-C follow-up — see `TECH_DEBT_REMAINING.md` §6.

---

## 8. ROI/payout formula canonical map

| Implementation | Location | Role |
|---|---|---|
| `calculatePayout(play)` | `server/services/roiEngine.ts` | **Canonical** — feeds the main dashboard/track-record ROI, plus `getROIMetrics`, `getPrimaryROIMetrics`, `groupBy*`, `buildFullROIReport` |
| `unitsWonPerDollarStaked(americanOdds)` | `server/mlb/episodes/mlbEpisodeMeasurement.ts` | Identical formula, **deliberately reimplemented** — the file's own header states every function here is pure with zero shared imports. Reused by `moundV2ComparisonStats.ts`. |

Both compute the same American-odds→units math; the duplication is intentional isolation (documented in-file), not oversight. See `TECH_DEBT_REMAINING.md` §4 for why this wasn't touched.

---

## 9. Admin endpoint map (tier-mutation side effects)

| Endpoint | Side effects |
|---|---|
| `PATCH /api/admin/users/:id/tier` (routes.ts) | Bare tier write only — no Stripe action, no play reset |
| `POST /api/admin/change-tier` (routes.ts) | Also cancels active Stripe subscription on downgrade, resets `playsUsed`/stamps `upgradedAt` on upgrade |

**These are not interchangeable.** Both routes now carry an inline comment cross-referencing the other (added in this pass). See `TECH_DEBT_REMAINING.md` §4 for the open question of whether/how to unify them.

---

## 10. Legacy LiveSignalBus bypass routes

Five routes are self-flagged via `markLegacyConsumer()` (each now also carries a `// LEGACY BYPASS` banner comment added in this pass, pointing back here):

| Route | File:line (approx, post-cleanup) |
|---|---|
| `GET /api/mlb/live-games` | `server/routes.ts` (~2154) |
| `GET /api/mlb/live-signals/:gameId` | `server/routes.ts` (~2752) |
| `GET /api/mlb/boxscore-engine-state/:gameId` | `server/routes.ts` (~3157) |
| `GET /api/mlb/hr-radar-analyze/:playerId/:gameId` | `server/routes.ts` (~4711) |
| `GET /api/mlb/debug` | `server/routes.ts` (~5270) |

These are large (300–1200+ line), live, production-serving handlers that read live game/signal state outside the canonical ENGINE→NORMALIZER→LiveSignalBus flow. Migrating them requires a dedicated pass with a test harness — see `TECH_DEBT_REMAINING.md` §3. `GET /api/mlb/hr-radar` (the canonical, active HR Radar data source consumed by the live ladder) is intentionally **not** marked — its own comment explains it isn't a bypass and marking it previously polluted the metric.

---

## 11. Script directories map

| Directory | Purpose | Notes |
|---|---|---|
| `script/` | Just `build.ts` — the actual `npm run build` entrypoint | Singular name, one file; directly wired into `package.json` |
| `scripts/` | Repo-root dev/audit/backtest tooling (`drift-check.mjs`, `backtestHrRadar.ts`, `seed-stripe-products.ts`, `snapshotBatterRollingStats.ts`, `validateHrRadarLadder.ts`, `plateIsoPopulationAudit.ts`, `post-merge.sh`, plus `drift-fixtures/`, `drift-snapshots/`, `pr7a0/` subdirs) | Not run against a live DB in production |
| `server/scripts/` | Server-runtime ops/backfill scripts (`backfillDnpVoids.ts`, `nbaCalibrationBackfill.ts`, `emailBlast*.ts`, `repairMoundBaselineOutcomeBackfill.ts`, etc.) | Run via `tsx` against the live DB — one is wired as an `npm` script (`send:welcome`) |

Not true duplicates — three genuinely different roles. `script/`'s singular naming is the one real oddity; not renamed this pass because `script/build.ts` is directly referenced by the deploy-critical `npm run build` command. See `TECH_DEBT_REMAINING.md` §12.

---

## 12. God-file inventory

| File | Lines (approx) | Primary responsibility | Why deferred this pass |
|---|---|---|---|
| `server/routes.ts` | ~11,100 | All Express route registrations + substantial inline business logic (163 registrations, handlers up to 1,227 lines) | No CI/test runner; line-by-line extraction needs a test harness first |
| `server/storage.ts` | ~8,940 | `IStorage` interface (132 methods) + one `DatabaseStorage` class implementing all persistence | Same — genuinely 15+ MLB subsystems' CRUD, not internal duplication; extraction is safe only with parity coverage |
| `server/mlb/liveGameOrchestrator.ts` | ~6,250 | MLB engine tick heartbeat — game discovery, live polling, state-change detection, engine triggering, HR-play grading | Same |
| `client/src/components/ncaab-admin-tab.tsx` | ~4,920 | NCAAB admin tab — game chips, market rows, sharp-money detection, parlay building, **and** client-side tier/odds derivation | Blocked on the NCAAB shared-contract gap (§5); this is architecture repair, not extraction |
| `client/src/pages/dashboard.tsx` | ~4,570 | Main authenticated dashboard | Same test-harness constraint as the server god files |

Full backlog with suggested extraction seams: `TECH_DEBT_REMAINING.md` §2.

---

## 13. Architecture vocabulary glossary

These terms are core, intentional vocabulary in this codebase — **not cleanup targets**, despite appearing hundreds of times each in a repo-wide grep:

- **CANONICAL** — the single source-of-truth implementation for a given responsibility (e.g. `CanonicalSignal`, canonical store patterns).
- **SHADOW** — a parallel, lower-floor or research-only track that writes to its own store and never affects production truth (e.g. shadow qualification, Mound V2 shadow evaluation, Plate challenger shadow).
- **GOLDMASTER** — a locked, version-stamped protected baseline (e.g. `MLB_GOLDMASTER_VERSION` in `server/mlb/goldmasterGuard.ts`) that drift-detection compares live output against.
- **LEGACY** — real, mostly-documented backward-compatibility scaffolding (field bridges, `@deprecated`-tagged fields with replacement guidance) — see §10 for the one concrete category of *active* legacy bypass this pass flagged for follow-up.

A full-repo marker sweep during this pass found only 1 real `TODO` in code, 0 `FIXME`, 0 real `HACK`-in-code — this codebase does not carry the traditional "abandoned TODO" flavor of debt; its debt is architectural (god files, duplicated small infrastructure, the NCAAB contract gap), not textual.
