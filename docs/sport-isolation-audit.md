# Sport-Isolation Audit (Read-Only Map)

This document is the FIX 1 deliverable from the cross-sport contamination
hardening prompt. It classifies every shared helper that touches NBA, MLB,
or NCAAB decisioning today, lists every signal-surfacing site in
`server/routes.ts`, and inventories every inline edge / probability
threshold that currently lives in shared route code.

It is observational — no files are moved by this audit.

---

## 1. Helper classification

### SAFE_SHARED — pure infrastructure, no sport math

Keep these shared. They handle plumbing, not decisions.

| File | Why safe |
|---|---|
| `server/db.ts` | Generic Drizzle DB handle. No sport branching. |
| `server/storage.ts` | CRUD over generic tables (`plays`, `users`, `daily_plays`, `rail_events`). Sport is a column value, not a behavioral branch. |
| `server/auth.ts` | Auth, sessions, `requireAuth` / `requireAdmin` / `requireTier`. No sport logic. |
| `server/utils/dateUtils.ts` | Generic ET-day helpers. |
| `server/utils/access.ts` | Tier → access map. Sport-aware in *enablement* (which sport a user can see) but not in math. |
| `server/services/timingService.ts` | Generic in-window check. |
| `server/services/playTracker.ts` | Persistence-only ledger. |
| `server/services/gradePersistedPlays.ts` | Generic settle/grade infrastructure. |
| `server/services/engineStats.ts` | Aggregation only — counts what each sport produced; never decides. |
| `server/services/engineSignal.ts` | Generic shape validator (`filterValidSignals`). |
| `server/services/engineValidation.ts` | Generic output-consistency filter. |
| `server/services/engineInputBuilder.ts` | Generic input shape builder. |
| `server/services/normalizationService.ts` | Generic name normalization. |
| `server/services/dataHealth.ts` | Health monitoring. |
| `server/services/sportsbookService.ts` | Generic best-bet picker over a sportsbook list. |
| `server/services/consensusLineService.ts` | Generic consensus-line aggregator. |
| `server/services/alertHooks.ts` | Generic alert dispatch. |
| `server/services/publicAnalyticsService.ts` | Read-only aggregator over settled plays for the public proof endpoint. |
| `server/services/roiEngine.ts` | ROI math over already-settled plays. Post-decision. |
| `server/utils/driftTrace.ts` | (NEW) Observability only, this audit's own emitter. |

### SPORT_OWNED — already correctly isolated

These already live in a sport namespace and are not shared across sports.
No action needed.

| File | Owner |
|---|---|
| `server/engines/nba/index.ts` | NBA — `processNBAEngine` |
| `server/engines/nba/types.ts` | NBA — `NBA_STRICT_RULES` / `NBA_FALLBACK_RULES` |
| `server/engines/nba/validation.ts` | NBA — `validateNBASignal` / `filterNBASignals` |
| `server/engines/mlb/index.ts` | MLB — `processMLBEngine` (HR-engine path; PROTECTED, see §4) |
| `server/engines/mlb/types.ts` | MLB — `MLB_STRICT_RULES` / `MLB_FALLBACK_RULES` |
| `server/engines/mlb/validation.ts` | MLB — `validateMLBSignal` / `filterMLBSignals` |
| `server/services/nbaStatsService.ts` | NBA |
| `server/services/nbaRotationHistoryService.ts` | NBA |
| `server/services/bartTorvik.ts` | NCAAB |
| `server/services/minutesProjectionService.ts` | NBA (minutes model) |
| `server/utils/mlbSessionDate.ts` | MLB |
| `server/nba/marketFamily.ts` | NBA |
| `server/nba/directionalBias.ts` | NBA |
| `server/ncaabService.ts` | NCAAB |
| `server/ncaabEnrichment.ts` | NCAAB |
| `shared/mlbSignal.ts` | MLB |

### UNSAFE_SHARED — currently changing outcomes across sports

These are the real contamination risks. Each gets a follow-up task in
`docs/sport-isolation-followups.md`.

| File | Why unsafe | What needs to happen |
|---|---|---|
| `server/routes.ts` (8001 lines) | Hosts inline edge gates (§3), inline tier assignment for NCAAB (line 517), and many surfacing payloads. A change to an inline gate silently affects whichever sport's route happens to call it. | FIX 2 — split into `routes/nbaLive.ts`, `routes/nbaHalftime.ts`, `routes/mlbLive.ts`, `routes/ncaabLive.ts`. Move inline thresholds out (FIX 5). |
| `server/oddsService.ts` (1489 lines) | Single `getPlayerOdds()` is called by NBA live, NBA halftime, NCAAB, and MLB code. Stale-line / degraded-fallback policy is decided here, not per-sport. | FIX 3 — wrap in sport adapters: `getNBAHalftimeOdds`, `getNBALiveOdds`, `getMLBLiveOdds`, `getNCAABLiveOdds`. |
| `server/services/topPlaysService.ts` | Surfaces "best plays" across sports using shared sort/threshold logic. | Audit per-sport call sites; move thresholds into sport-owned constants. |

---

## 2. Signal-surfacing site inventory in `server/routes.ts`

Every place a play becomes a response payload, with current drift-trace
status:

| Line | Sport | Site | Drift-trace wired? |
|---|---|---|---|
| ~520–545 | NCAAB | `confidence: confidenceTier` inside `.map()` for `/api/ncaab-signals` | ✅ Yes (this pass) |
| ~1685 | MLB | `confidenceTier: qs.confidenceTier` per qualified signal | ❌ Not wired (HR-engine-protected — see §4) |
| ~1745 | MLB | `confidenceTier: qs.confidenceTier` per engine-output signal | ❌ Not wired (HR-engine-protected) |
| ~1788 | MLB | After `processMLBEngine()` — per-play loop | ✅ Yes (this pass) |
| ~2036 | MLB | `confidenceTier: qs.confidenceTier` in HR-radar payload | ❌ Not wired (HR alert path) |
| ~2275–2354 | MLB | HR alert legacy mapping — `confidenceTier` translation | ❌ Intentionally NOT wired (HR engine immutable) |
| ~3105 | (mixed) | `output.recommendedSide, output.confidenceTier` from generic engine shim | ❌ Not wired (ambiguous sport boundary) |
| ~4555 | NBA | `confidence: s.edge >= 10 ? "ELITE" …` inline tier (live edge) | ❌ Not wired (FIX 5 candidate — inline threshold) |
| ~4607 | NBA | After `processNBAEngine()` — per-play loop | ✅ Yes (this pass) |
| ~5210–5250 | NBA | Halftime inline tier ELITE/STRONG/VALUE + degraded volatile path | ❌ Not wired (FIX 5 candidate — inline threshold) |
| ~5396 | NBA | Tier A/B/C selection (edge >= 15 / 10 / 6) | ❌ Not wired (FIX 5 candidate — inline threshold) |
| ~6973, ~7191 | (mixed) | `confidenceTier: p.confidenceTier ?? null` in admin/analytics payloads | ❌ Not wired (read-only re-emit) |

**Coverage today:** one drift trace per engine call for NBA + MLB engine-owned
paths, plus per-play traces for NCAAB inline path. Inline-threshold paths
in NBA live/halftime are intentionally NOT instrumented in this pass — they
will get traces during FIX 5 when those thresholds move out of `routes.ts`.

---

## 3. Inline edge / probability threshold inventory

Every inline numeric gate found in `server/routes.ts`. None of these have
moved in this pass — they are catalogued here for FIX 5.

| Line | Sport (inferred) | Threshold | Context |
|---|---|---|---|
| 517 | NCAAB | `prob >= 75` ELITE / `>= 65` STRONG / `>= 55` LEAN / else NO_EDGE | NCAAB inline tier — `[ENGINE INPUT][NCAAB]` log right after |
| 4350 | NBA live | `if (edge < 3) continue` | `[NBA_ROUTE_FILTER]` log inside; `DEBUG_NBA` env-gated |
| 4546 | NBA live | `s.edge >= 10 ? ELITE : >= 7 ? STRONG : LEAN` | tier label in surfacing payload |
| 5201 | NBA halftime | `if (edge < 4) continue` | halftime route gate |
| 5218–5224 | NBA halftime | `edge >= 20 → ELITE`, `>= 15 → STRONG`, `>= 10 → VALUE`, else volatile | halftime tier ladder |
| 5388 | NBA halftime | `edge >= 15` (Tier A), `>= 10 && < 15` (Tier B), `>= 6 && < 10` (Tier C) | tiered selection |
| 7317–7319 | NBA / NCAAB / MLB | `nba prob >= 75`, `ncaab prob >= 75`, `mlb prob >= 65` | live-signal-counts endpoint — display-only |

Plus implicit shared thresholds inside engine modules (already SPORT_OWNED):

| Source | Owner |
|---|---|
| `engines/nba/types.ts:NBA_STRICT_RULES` | NBA |
| `engines/nba/types.ts:NBA_FALLBACK_RULES` | NBA |
| `engines/mlb/types.ts:MLB_STRICT_RULES` | MLB (PROTECTED) |
| `engines/mlb/types.ts:MLB_FALLBACK_RULES` | MLB (PROTECTED) |

---

## 4. MLB / HR calibration block (FIX 4 status)

**Status: BLOCKED. Intentionally not moved or rewritten in this pass.**

The cross-sport contamination prompt's FIX 4 requires moving "calibration
shrink, confidence ceilings, volatility suppression" into per-sport
namespaces. For MLB this would touch the HR engine's calibration code,
which the user has explicitly protected with the standing rule:

> "never modify HR engines/scoring/calibration"

### Where the protected MLB / HR calibration math currently lives

| File | What it owns |
|---|---|
| `server/engines/mlb/index.ts` | `processMLBEngine` — HR-aware engine entry, including `mapMLBConfidence` (probability → tier) and post-engine confidence resolution |
| `server/engines/mlb/types.ts` | `MLB_STRICT_RULES`, `MLB_FALLBACK_RULES`, contact-quality thresholds, near-HR thresholds |
| `server/engines/mlb/validation.ts` | `validateMLBSignal` / `filterMLBSignals` — qualification gates that feed the engine |
| `server/services/engineInputBuilder.ts` (MLB-touching paths) | Input shape construction for MLB candidates |
| `shared/mlbSignal.ts` | Shared MLB signal contract |
| `server/routes.ts` HR alert paths (~2267–2354) | HR-radar tier translation and surfacing |

### What "moving FIX 4 for MLB" would require

Any of these would constitute touching protected code:
1. Extracting `mapMLBConfidence` into `engines/mlb/confidence/*`.
2. Splitting `MLB_STRICT_RULES` confidence ceilings out of `types.ts`.
3. Rewriting how the HR alert path translates `qs.confidenceTier` into the
   surfacing tier.
4. Changing the post-engine `mapMLBConfidence(prob)` fallback ladder
   (`>=70 elite`, `>=58 strong`, else developing).

None of those happen in this pass.

### What was changed for MLB in this pass (audit answer)

1. Added one observability loop after `processMLBEngine` at routes.ts ~1771
   that READS each play's existing `confidenceTier`/`confidence` fields and
   emits a `[MLB_DRIFT_TRACE]` log. **No engine field is mutated.**
2. The loop is positioned AFTER the existing `[MLB ENGINE]` summary log
   and BEFORE `recordEngineRun` — both pre-existing call sites — so it
   cannot reorder execution.

### What FIX 4 unblock would require from the user

To extract MLB confidence/calibration into a `confidence/` namespace
without violating the standing rule, the user must explicitly relax
the "never modify HR engines/scoring/calibration" rule for the
extraction-only refactor (no math changes), and ideally provide a
golden-fixture set so we can prove the extracted module produces
bit-identical output. Until then, FIX 4 stays scoped to NBA / NCAAB
only — and NCAAB doesn't have a `confidence/` module to extract from
because its tier math lives inline in `routes.ts` (see §3).

---

## 5. Drift-trace coverage matrix

| Sport | Engine path traced? | Inline path traced? | Notes |
|---|---|---|---|
| NCAAB | n/a (no engine module) | ✅ at routes.ts:523 | All NCAAB surfacing flows through one inline tier site. |
| NBA | ✅ at routes.ts:4600 (per-play) | ❌ FIX 5 work | Inline tier paths at 4546, 5218, 5388 will get traces when thresholds move out. |
| MLB | ✅ at routes.ts:1771 (per-play) | ❌ HR-engine protected | Per-play surfacing inside HR alert path is intentionally NOT instrumented. |

Disable traces in noisy environments with `DRIFT_TRACE_DISABLED=true`.

---

## 6. Drift-check harness coverage

`scripts/drift-check.mjs` currently snapshots:

| Sport | Fixture | Engine entry | Status |
|---|---|---|---|
| NBA | `elite_high_prob_over.json` | `processNBAEngine` | active |
| MLB | `strong_batter_hr.json` | `processMLBEngine` | active (protected — fixtures must remain stable to detect any HR-math drift) |
| NCAAB | (placeholder) | (no engine yet) | inactive — pending NCAAB engine extraction |

Run `node scripts/drift-check.mjs` to verify, `--update` to regenerate after
intentional engine changes.
