# PR0 — Spec-vs-Repo Conflicts, Migration Plan & PR1 File-Level Plan

**Status:** PR0 discovery. Non-production-change baseline. The build spec
instructs us to *flag* conflicts with weaker legacy math, not silently preserve
them. This document does that and lays out an executable PR1.

---

## 1. Conflicts between current behavior and the normative spec

| # | Conflict | Current state | Spec requirement | Resolution (phase) |
| --- | --- | --- | --- | --- |
| C1 | **NBA model is live, not pregame as-of** | `probabilityEngine.computeProbability`: static 0.45/0.35/0.20 recent/season/role blend, `phi` Normal CDF, shrink-to-0.5 calibration | As-of Bayesian posteriors (§5B.5) + seeded Monte-Carlo **joint** simulation (§6A) with a **blind projection core separated from the line-decision layer** | Build a **new** `server/engines/nbaPregame/` — do **not** repurpose the live engine in place (PR3/PR4). Keep the live engine untouched. |
| C2 | **Documented NBA overconfidence** | `probabilityFinalizer.ts` header: 80–100% bucket = 28.6% actual vs 60.1% predicted | New pregame calibrator, walk-forward, coherent over/under complement (§8A.3) | New sport-owned calibrator in PR4; the live finalizer stays as-is for the live product. |
| C3 | **No `nfl` sport** | `Sport = "mlb"\|"nba"\|"ncaab"` (`shared/canonicalSignal.ts`); schema enums; `resolveAccess` has no `hasNFL` | NFL as a first-class sport + entitlement | Extend union + schema enum + `resolveAccess`/`requireTier` in **PR2 (contract)** / **PR6 (data)**. **Not PR0/PR1.** |
| C4 | **`persisted_plays` lacks target provenance** | Has NBA diagnostics but no `surface`, `projection_snapshot_id`, `decision_snapshot_id`, `target_tier`, `role_certainty` | Official target row carries snapshot lineage (§10) | Additive `ADD COLUMN IF NOT EXISTS` via the existing self-heal pattern in **PR2**. Never rewrite existing columns. |
| C5 | **"Empty result is illegal" (legacy)** | Older project rule / MLB gotchas | §3.1: an **honest empty qualified state is allowed**; no fallback picks | New feature adopts `no_qualified_targets` status; **supersedes** the legacy rule for pregame targets only. |
| C6 | **EV / edge framing** | `persisted_plays.edgeGap`, `bookImplied`, NBA "edge" | Projection blind to price/EV; `confidenceMarginPp = 100×(p−0.50)` is **not** EV (§5, §8A) | New contract fields; captured American odds kept for settlement/ROI **reporting only**. |
| C7 | **Analytics is MLB-only** | `analyticsEvent.ts` version strings from MLB goldmaster | Read-only per-sport analytics | Extend read-only emitters for NBA/NFL in PR5/PR8; never mutate runtime (repo hard rule). |
| C8 | **No as-of feature store / leakage firewall** | Rates read live in routes/services | `validAt`/`knownAt`, `knownAt <= predictionAt`, replay parity (§5A.3, §9A.11) | The core of **PR1**. |

**Non-conflicts (reuse as-is):** `persistedPlays` ledger + `recordPlay`/`settlePlay`
gateway, `resolveAccess` entitlement model, odds batching/cache, migration
bootstrap pattern, the MLB pregame **UX** patterns, and sport isolation.

---

## 2. Migration principles

1. **Additive only.** New tables + additive `ADD COLUMN IF NOT EXISTS`. No
   destructive SQL (the persistence tests already assert this).
2. **No second system.** One ledger (`persisted_plays`), one gateway, one auth
   resolver, one odds layer, one analytics buffer — extended, never forked.
3. **Sport isolation.** `server/engines/nbaPregame/**` and
   `server/engines/nflPregame/**` never import each other or MLB engine math.
   Shared layer = infrastructure + display contracts only.
4. **Fail closed.** New public surfaces behind fail-closed env flags
   (`NBA_PREGAME_TARGETS_SHADOW/PUBLIC`, `NFL_...`) following `plateShadowFlags.ts`.

---

## 3. PR1 file-level plan — *As-of data & temporal-learning foundation*

**PR1 scope:** immutable source snapshots, as-of feature store with
`validAt`/`knownAt` + leakage firewall, canonical entity/market semantics,
rolling current+2-season posterior-state scaffolding, historical-replay harness,
and live/replay parity fixtures. **No public API. No sport projection math. No
NFL. No `Sport`-union change.**

> Exact filenames below are proposals confirmed against current repo conventions
> (co-located `*.test.ts` run via `npx tsx`; `dbMigrations/*Persistence.ts`
> bootstrap wired in `server/index.ts`; `shared/` transport contracts). Confirm
> once more at PR1 start before creating.

### 3a. New files
- `shared/pregameTargets/featureStore.ts` — `AsOfFeatureRow` contract
  (`validAt`/`knownAt`/`featureVersion`/state enum: observed-zero | not-applicable
  | missing | stale | disagreement | imputed).
- `shared/pregameTargets/canonicalEntities.ts` — canonical player/team/game/market
  identity + fail-closed resolution result types.
- `server/pregameTargets/featureStore/asOfFeatureStore.ts` — read/write with
  `knownAt <= predictionAt` enforcement.
- `server/pregameTargets/featureStore/leakageFirewall.ts` — assertions from
  §9A.11 (reject future `knownAt`, outcome-in-input, same-game self-update, etc.).
- `server/pregameTargets/posteriorState/posteriorState.ts` — versioned sufficient
  statistics + ESS (`ESS = (Σw)²/Σw²`), rolling current+2-season contribution.
- `server/pregameTargets/posteriorState/recencyWeights.ts` — §5B weight product
  (season × recency × role/org/scheme continuity × context × quality), half-lives.
- `server/pregameTargets/replay/historicalReplayHarness.ts` — rolling-origin
  as-of replay (shared builder for live inference AND backtest).

### 3b. Existing files expected to change
- `shared/schema.ts` — **add new tables only** (`pregame_raw_source_snapshots`,
  `pregame_feature_snapshots`, `pregame_posterior_states`). No edits to existing
  tables in PR1.
- `server/storage.ts` — add `IStorage` methods for the new tables (INSERT-first,
  idempotent), mirroring the mound/plate method groups.
- `server/index.ts` — add `ensurePregameTargetsFoundationSchema(pool)` to the
  boot bootstrap block (~lines 230–272), following the existing pattern.

### 3c. Migrations
- `server/dbMigrations/pregameTargetsFoundationPersistence.ts` — idempotent
  `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` for the three new
  tables; **no** `ALTER` in PR1 (no existing table touched).

### 3d. Test files (`npx tsx`, self-executing)
- `shared/pregameTargets/featureStore.test.ts` — state-enum + contract invariants.
- `server/pregameTargets/featureStore/leakageFirewall.test.ts` — every §9A.11
  rejection; missing vs observed-zero distinguishable.
- `server/pregameTargets/posteriorState/posteriorState.test.ts` — ESS,
  current > prior-1 > prior-2 weighting, prior-mass guards at ESS boundaries,
  deterministic update w/ included-game lineage, no self-update.
- `server/pregameTargets/posteriorState/recencyWeights.test.ts` — role decays
  faster than skill; continuity discounts; season-rollover drops oldest season.
- `server/pregameTargets/replay/liveReplayParity.test.ts` — byte-equivalent
  live vs replay feature fixtures on golden inputs.
- `server/dbMigrations/pregameTargetsFoundationPersistence.test.ts` — idempotence,
  IF-NOT-EXISTS-only, no destructive SQL (mirror `mlbRecommendationEpisodePersistence.test.ts`).

### 3e. Bootstrap / wiring
- One `await ensurePregameTargetsFoundationSchema(pool)` added to `server/index.ts`
  boot sequence. No scheduler/cron wiring in PR1 (no build loop yet).

### 3f. Files & production paths PR1 must NOT touch
- `server/nba/**` (live probability engine, finalizer, archetypes) — **frozen**;
  the golden fixtures in `server/pregameTargets/__fixtures__/` guard them.
- `server/mlb/**`, `server/ncaab*`, `server/engines/nba/**` — no edits.
- `persisted_plays` table columns, `recordPlay`, `settlePlay`, `playTracker` —
  untouched in PR1 (provenance columns land in PR2).
- `shared/canonicalSignal.ts` `Sport` union — unchanged until PR2.
- `server/routes.ts`, `client/**` — no route or UI changes in PR1.
- `server/analytics/**` — no changes; remains read-only, MLB-only.
- `package.json`, Vite/Drizzle config — unchanged.

---

## 4. PR0 exit criteria (met)

- [x] Current-state trace with verified paths (`PR0-current-state-trace.md`).
- [x] Data-flow diagram with the enforced blindness boundary.
- [x] Feature + per-season historical coverage matrices with honest 4-way
      classification (`PR0-data-coverage.md`); no "method exists = data exists".
- [x] Conflicts + migration plan (this doc).
- [x] Golden fixtures locking current MLB/NBA behavior at observable boundaries
      (`server/pregameTargets/`): NBA finalize/compute (incl. zero-sample)/wrapper,
      Plate & Mound scoring/tier/direction, Mound grading (push/DNP/missing/
      correction), Plate win attribution, serialized `buildResponse`/
      `buildMoundResponse`, and Plate/Mound `signalToRow`↔`rowToSignal` mapping —
      each with a four-way boundary classification ledger
      (`__fixtures__/README.md`). Branch rebased onto `origin/main` (9 commits,
      Plate ISO layer); trace updated in §1a.
- [x] Structured PR1 file-level plan (this doc §3).
- [x] No production file modified (see verification evidence in the PR/commit).

**Stop after PR0.** PR1 begins only on explicit approval.
