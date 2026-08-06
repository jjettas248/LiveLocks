# CLAUDE.md

Guidance for Claude (and other AI coding assistants) working in this repo.

> **LiveLocks by PropPulse** — full-stack PWA for NBA, MLB, and NCAAB betting analytics. Real-time probabilities, correlation-adjusted parlays, HR Radar, and a canonical signal pipeline backed by a strict engine→bus→UI contract.

---

## 1. Run, Build, Validate

| Task | Command |
| --- | --- |
| Dev server (Express + Vite, single port) | `npm run dev` |
| Production build | `npm run build` |
| Typecheck (must be clean before commit) | `npx tsc --noEmit` |
| API codegen | `npm run codegen` |
| DB migrate (Drizzle) | `drizzle-kit push:pg` |

**Required env vars:** `ODDS_API_KEY`, `ODDS_API_KEY_2`, `ODDS_API_KEY_3` (rotation), `DATABASE_URL`, plus Stripe / Resend / Twilio credentials managed through Railway environment variables (Railway Variables) — **never** hardcode or echo their values.

**Regression suites (run before merging engine-adjacent changes):**
```
npx tsx server/mlb/phase3bRegression.test.ts        # 21 invariants
npx tsx server/mlb/shadowOutcomeWiring.test.ts      # 41 invariants
npx tsx server/mlb/hrRadarLifecycleRepair.test.ts   # 34 invariants
npx tsx server/mlb/hrRadarStateMachine.test.ts      # 5 invariants
npx tsx server/mlb/hrRadarReadyToFire.test.ts       # Ready→Fire promotion incl. peak-currency gate
npx tsx server/mlb/hrRadarFireOnlyGrading.test.ts   # FIRE-only official grading (reachedFireCommitment)
npx tsx server/mlb/nearHrContact.test.ts            # near-HR + "almost HR" detection
npx tsx server/mlb/pullAndPregame.test.ts           # pull rate + pregame HR-form prior
npx tsx server/mlb/ibbAndRecentForm.test.ts         # recent form streak + IBB feared-slugger prior
npx tsx server/mlb/hrReviewClassifier.test.ts       # 30 invariants — pre-HR review bucket taxonomy
npx tsx server/mlb/hrMissDiagnostics.test.ts        # 78 invariants — HR miss diagnostic LLM-payload builders
npx tsx server/mlb/hrRadarFireOnlyGrading.test.ts   # FIRE-only official grading, both ledger sides
npx tsx server/mlb/hrOccurrenceEngine.test.ts       # occurrence engine: edge decouple + conv-cal rail + pitcher-fade-only gate
npx tsx server/mlb/hrEvGate.test.ts                 # edge/EV decoupling — HR Radar tier is odds-independent
npx tsx server/mlb/hrRadarFreshnessOverlay.test.ts  # canonical-store freshness overlay (re-bucket/surface/terminal-safety)
npx tsx server/mlb/hrRadarRuntimeSmoke.test.ts      # read-only contract smoke (freshness + FIRE-only record)
npx tsx server/mlb/liveStateEvents.test.ts           # event-driven state classification: no-op poll, ordinary pitch != ball_in_play, completed AB, real contact, 74->75 threshold crossing, inning/pitcher change, family closure
npx tsx server/mlb/edgeCarryForward.test.ts          # narrowed-cycle carry-forward: scope-not-absence predicate, no mutation of carried signals, outputs travel with signals, resolved/stale drops
npx tsx server/mlb/liveEdgeMetrics.test.ts           # polling/odds observability: bounded counters, rate-limited tags, odds-requests-per-live-game-hour KPI, never throws
npx tsx server/odds/mlbOddsPriceFloor.test.ts        # side-specific -200 active-polling floor (opposite side never rescues), approved-book-only best price, discovery for unseen pricing
npx tsx server/oddsService.test.ts                   # MLB Live Edge unified raw-odds cache: single key (no pregame/live split), no in_play, 3-book allowlist, single-flight, cache-only reads, status-based freshness, NBA unaffected
npx tsx server/odds/mlbOddsRefreshCoordinator.test.ts # MLB odds refresh coordinator: interest dedup/priority/immediate-fire, final stops scheduling, per-game cleanup
npx tsx server/analytics/hrRadarOfficialSplit.test.ts # analytics official(FIRE) vs shadow(watch) split
npx tsx server/growth/hrBoardStudio.test.ts          # HR Board Studio: no-link copy, compliance, movement purity, recap, admin-auth gate
npx tsx server/mlb/pregamePowerRadar/plateChampionJul20Regression.test.ts # Plate champion (plate_jul20_restored_v1) policy lock — research inputs/BBE/Attack Environment cannot move champion score/tier/suppression; driver universes; publication is explicit
npx tsx server/mlb/pregamePowerRadar/plateModelShadowIsolation.test.ts   # Plate champion-vs-challenger isolation — identical frozen input hash, shadow cannot mutate or block production, sticky challenger exposure, fail-closed shadow flag
npx tsx server/mlb/pregamePowerRadar/plateModelComparisonStats.test.ts   # Plate model comparison analytics — sticky-to-sticky exposure, HR vs TB never blended, missing comparisons reported not inferred
npx tsx server/mlb/pregamePowerRadar/isoAssessment.test.ts               # Canonical true-ISO assessment (iso_assessment_v1): fail-closed validation (pct-scale/NaN/neg/no-sample), SLG−AVG↔counting-stats parity, shrinkage-to-prior, all 5 tiers reachable, fallback never elite
npx tsx server/mlb/pregamePowerRadar/isoTagSelection.test.ts             # ISO tag selectivity + CHAMPION-SAFETY: former universal "Elite Isolated Power" now true-ISO gated; power_iso emission/positiveDriverCount/score10 invariant; assessment-boundary audit (attempted=valid+unavailable) + distribution >25% guardrail
npx tsx server/mlb/pregamePowerRadar/plateChampionSlateInvariance.test.ts # Slate-level champion-invariance lock (golden ranked identities/score/tier/suppression/publication) + all-five ISO display tiers reachable, only one Elite chip
npx tsx server/mlb/pregamePowerRadar/isoPopulationAuditGate.test.ts       # Pre-deployment population-audit gate: empty/all-unavailable/too-small exports FAIL (no false certification); healthy passes; over-cap fails
npx tsx server/mlb/pregamePowerRadar/winAttribution.test.ts  # Pregame Radar Win Attribution (pregame_win public vs calibration_miss internal; first-AB label; daily-log grouping)
npx tsx server/mlb/pregamePowerRadar/calibrationStats.test.ts # Pregame Radar public stats (wins-only) vs admin calibration (full denominator: byTier/byScoreBand/byDriver + conversion rates)
npx tsx server/mlb/pregamePowerRadar/gradedStatePreservation.test.ts # Pregame Radar graded-state carry across snapshot rebuilds + wrong-slate snapshot refusal + lineup-dropout carry-forward
npx tsx server/mlb/pregamePowerRadar/finalBoxScoreOutcome.test.ts # Pregame Radar restart-proof grading fallback (on-demand FINAL box score when the in-memory cache has no line): HR still settles as pregame_win, public/internal split, miss→calibration_miss, absent batter→null, exact TB
npx tsx server/mlb/pregame/mound/moundGradedStatePreservation.test.ts # Mound Radar graded-state carry across snapshot rebuilds + wrong-slate snapshot refusal + starter-drop carry-forward
npx tsx server/mlb/pregame/mound/contactRisk.test.ts # Mound Radar Hit/HR Susceptible High/Low tag (informational-only, zero effect on score10/tier)
npx tsx server/mlb/pregame/mound/matchupAdjustedKs.test.ts # Mound Radar Matchup Adj. Ks enrichment + avgInningsPerStart swingman-inflation regression
npx tsx server/mlb/pregame/mound/moundScoring.test.ts # Mound Radar component scorers + composite score10/tier invariants
npx tsx server/mlb/pregame/mound/moundDirection.test.ts # Mound Radar Fade/Follow direction thresholds (server-stamped once at build time)
npx tsx server/mlb/pregame/mound/moundPublicSettlement.test.ts # Mound Radar public-recommendation settlement lanes: market (Cashed/Missed/Push from the frozen sportsbook bet) vs model_review vs integrity_gap; durable-public-exposure direction resolution (a Follow-public card is never settled under Fade rules); Follow/Fade never remapped to OVER/UNDER; engine baseline never substituted for a missing line
npx tsx server/mlb/pregame/mound/moundOutcomeAttribution.test.ts # Mound Radar settlement rule: Follow (Over) mound_win vs Fade (Under) mound_fade_win vs mound_calibration_miss (internal calibration, unchanged) + deriveMoundMarketOutcome/deriveModelOutcomeLabel/buildMoundSettlementView (additive market-settlement contract) + MOUND_WIN_COPY/MOUND_FADE_WIN_COPY never say "Cashed"
npx tsx server/mlb/pregame/mound/moundCalibrationStats.test.ts # Mound Radar public/admin stats — Fade wins fully separate from Follow/Over win counters
npx tsx server/mlb/pregame/mound/moundAnalyticsSeparation.test.ts # Mound vs Plate outcome-taxonomy + in-memory store isolation
npx tsx server/mlb/pregame/mound/moundKDisplaySplit.test.ts # Mound Radar K Skill/K Matchup/K Projection/K Line Value display decomposition (never blend skill+platoon fit into one "Weak" badge; Over/Under sign guard)
npx tsx server/mlb/pregame/mound/evaluationSnapshot.test.ts # Mound Radar frozen evaluation-snapshot invariants (Follow/Fade conflict handling, §7b shadow measurements) + postedLine.sportsbook provenance capture at freeze time
npx tsx server/mlb/pregame/mound/loadMoundSnapshotFromDb.test.ts # Mound Radar boot-hydration reconstruction, incl. market-outcome/provenance fields surviving DB round-trip via the existing whole-object outcomes jsonb column
npx tsx server/mlb/pregame/mound/moundMarketOutcomeBackfill.test.ts # Mound Radar market-outcome historical backfill planner — only backfills where a real frozen pregame line is provably persisted, never fabricated, idempotent
npx tsx server/mlb/pregame/composition/moundPlateTargets.test.ts # Cross-Radar (neutral composition layer, not inside either engine): pure Mound→Plate HR-target join/rank/dedupe — cr_high gate, gameId+pitcherId join, deterministic HR-score-first ranking with overall-score/slot/batterId tie-breaks, capped at 3, never mutates inputs
npx tsx server/mlb/pregame/composition/enrichMoundResponse.test.ts # Cross-Radar response enrichment: applies Plate's REAL canonical isPublicPregameSignal gate (not a suppressed/tier approximation), wraps an already-built MoundRadarResponse without mutating it, canonical fields (score10/tier/moundDirection/ordering/diagnostics) pass through byte-identical
npx tsx client/src/lib/mlb/moundSettlementLabels.test.ts # Mound Radar baseline-only fallback label — never renders the words Cashed/Missed/Push (reserved for a real market result); baseline tie reads "Matched Engine Baseline"
npx tsx client/src/components/mlb/MoundWinCard.test.ts # Mound Radar daily-strip public copy — model-baseline aggregates never render "Cashed"
npx tsx server/mlb/pregamePowerRadar/diagnostics.test.ts            # Pregame Radar public-visibility predicate (final-but-ungraded stays visible, graded miss hides, postponed hides)
npx tsx server/mlb/pregamePowerRadar/slateDateRepair.test.ts # Pregame Radar slate-date repair planner (startsAt/gameDate correction, collision detection, no blanket day-shift)
npx tsx server/mlb/pregamePowerRadar/nearHrRecentForm.test.ts # Pregame Radar near-HR recent-form component (retroactive nearHrContact reuse, recency weighting, consecutive-day bonus, leakage guard)
npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/recentContactForm.test.ts # Plate HR V2 (shadow) stabilized recent-contact form — EWMA/EV90/air%/barrel% from the real contact_events stream, reliability-blended with a season baseline (15-BBE regressed, 25–50 > spike), leakage boundary, no HR-count leakage, pulled-air season-only, xHR-per-contact null
npx tsx server/utils/dateUtils.test.ts               # slateDateET() 6am-ET rollover + toEtDateKey() ET calendar-date conversion invariants
npx tsx server/dbMigrations/hrRadarResearchPersistence.test.ts       # HR Radar research schema bootstrap idempotence + constraint + no-destructive-SQL guard
npx tsx server/mlb/hrRadarResearch/hrRadarResearchContracts.test.ts  # HR Radar research Zod contracts (feature/trigger/eligibility/label/artifact/policy) + fail-closed flag parsing
npx tsx server/mlb/marketStarvationGuard.test.ts     # market-starvation evaluator threshold logic + never-throws guarantee + cooldown/recovery logging
npx tsx shared/mlbRecommendationEpisode.test.ts       # MLB recommendation episode contract: frozen-field mutation guard, status transitions, settlement grades frozen side/line/price
npx tsx shared/mlbEmptyStateReason.test.ts            # MLB empty-state reason contract: exhaustive reason->message coverage, builder defaults/overrides
npx tsx server/odds/mlbOddsProvenanceContract.test.ts # MLB odds provenance: reader-driven freshness classification cross-checked against isMLBSnapshotFresh, Zod schema rejects synthetic/invalid provenance
npx tsx server/mlb/episodes/mlbOfficialRecommendationFirewall.test.ts # Official MLB recommendation firewall: rejects missing/stale/synthetic odds, side/probability consistency, game-state-driven freshness
npx tsx server/mlb/episodes/mlbEpisodeMeasurement.test.ts # MLB performance measurement: captured-price ROI (no -110 assumption), push/void handling, Brier/log-loss/calibration, breakdown grouping
npx tsx server/dbMigrations/mlbRecommendationEpisodePersistence.test.ts # MLB recommendation episode schema bootstrap idempotence + constraint + no-destructive-SQL guard
npx tsx server/mlb/pregame/mound/v2/moundV2Math.test.ts              # Mound V2 (shadow) statistical primitives: Poisson-binomial, negative-binomial, line-probability invariants
npx tsx server/mlb/pregame/mound/v2/batterStrikeoutProbability.test.ts # Mound V2 per-batter K-probability log-odds blend + degradation cases
npx tsx server/mlb/pregame/mound/v2/battersFacedWorkloadModel.test.ts # Mound V2 batters-faced + outs workload distributions, pull-risk adjustment
npx tsx server/mlb/pregame/mound/v2/moundV2Engine.test.ts             # Mound V2 distributional engine: OVER/UNDER/push invariants, low-BF/missing-lineup handling, zero production-Mound import edges
npx tsx server/mlb/pregame/mound/v2/moundV2PromotionGate.test.ts      # Mound V2 promotion-readiness criteria checker (not an auto-promotion)
npx tsx server/mlb/pregame/mound/v2/frozenMoundShadowInput.test.ts    # Mound V2 frozen input contract: deterministic feature hash, deep-freeze immutability, gameId/gamePk identity capture
npx tsx server/mlb/pregame/mound/v2/moundV1Adapters.test.ts           # Mound V2 adapters translating V1's own component scores into V2's frozen-input shape
npx tsx server/mlb/pregame/mound/v2/moundV2ShadowEvaluation.test.ts   # Mound V2 shadow evaluation: builds frozen input, runs the V2 engine, captures V1 parity + latency, never throws
npx tsx server/mlb/pregame/mound/v2/moundV2ShadowRunner.test.ts       # Mound V2 shadow runner: behavioral proof (injected throwing evaluate/record stubs) that a shadow-path defect can never propagate into V1's build loop
npx tsx server/mlb/pregame/mound/v2/moundV2ShadowLatency.test.ts      # Mound V2 shadow latency benchmark (committed regression guard, p50/p95/p99/max over a realistic 9-batter lineup)
npx tsx server/mlb/pregame/mound/v2/moundV2ShadowWiring.test.ts       # Mound V2 shadow structural proof: shadow block runs after V1's signal is fully assembled, never assigns into signal/signals
npx tsx server/mlb/pregame/mound/v2/moundV2ShadowPersistenceBuilder.test.ts # Mound V2 shadow persistence row builder: frozen fields incl. v1RecommendedSide/gamePk/scheduledGameTime carry through exactly, 2-rows-per-market invariant
npx tsx server/mlb/pregame/mound/v2/moundV2ShadowStorage.integration.test.ts # Mound V2 shadow storage against a REAL database: insert/idempotency, grading immutability, real regrade audit, reconciliation-attempt bookkeeping, realistic-volume + index-usage proof
npx tsx server/mlb/pregame/mound/v2/moundV2ShadowGrading.test.ts      # Mound V2 shadow grading: pure decision function (hold/void/grade), game-status classification, line-vs-final comparison
npx tsx server/mlb/pregame/mound/v2/moundV2ShadowGrading.integration.test.ts # Mound V2 shadow grading sweep + regrade orchestration against monkey-patched storage: idempotent sweep, void-reason capture, official-stat-correction audit trail
npx tsx server/dbMigrations/moundV2ShadowPersistence.test.ts          # Mound V2 shadow prediction schema bootstrap: idempotent self-heal ADD COLUMN only, required indexes, no destructive SQL
npx tsx server/mlb/pregame/mound/v2/moundV2ComparisonStats.test.ts    # Mound V2 vs V1 comparison: honest probability-quality evaluation (named non-V1 comparator) split from paired decision-policy evaluation (captured-price V1 ROI, never -110 assumed, legacy-missing-price exclusion)
npx tsx server/mlb/pregame/mound/v2/moundV2PromotionEvidenceAdapter.test.ts # Mound V2 promotion evidence adapter: wires the comparison engine's two evaluation split into the gate's required evidence shape
npx tsx server/mlb/pregame/mound/v2/moundV2ShadowReconciliation.test.ts # Mound V2 shadow reconciliation policy: eligibility/exponential-backoff/postponed-cooldown decisions, grading coverage report (coverage ratio, oldest pending, stale alerts, provider failures, unresolved pitchers)
npx tsx server/mlb/pregame/mound/v2/moundV2ShadowReconciliationSweep.integration.test.ts # Mound V2 shadow reconciliation sweep: behavioral proof of per-game single-flight fetch dedup, whole-sweep single-flight, rate limiting, honest failure attribution, never-throws
npx tsx server/mlb/pregame/mound/v2/moundV2ShadowReconciliationWiring.test.ts # Mound V2 reconciliation structural proof: zero reachability from buildMlbMoundRadar.ts, syncGameBoxScore called from exactly one file, zero sportsbook/odds imports
npx tsx server/utils/mlbPreviewAccess.test.ts          # MLB free-preview consume-key resolution: gameId always wins, gameId-less routes/resources key independently (never a shared flat key), denylist for raw odds/calculation routes
npx tsx server/mlbAccessControlGate.integration.test.ts # MLB access-control gate against a REAL app+DB: no cross-route budget sharing, denylisted raw-odds/calc routes always require paid access, per-resource (player) keying, real concurrent-request atomicity, admin/paid bypass unaffected
npx tsx shared/pregameTargets/featureStore.test.ts        # Pregame Targets PR1 — AsOfFeatureRow contract: 7-state enum, value-bearing vs null states, missing != observed_zero, structural validity
npx tsx shared/pregameTargets/canonicalEntities.test.ts   # Pregame Targets PR1 — canonical id build/parse + fail-closed resolution (unknown/malformed/ambiguous), half-open trade-window handoff
npx tsx server/pregameTargets/featureStore/leakageFirewall.test.ts # Pregame Targets PR1 — leakage firewall: future knownAt, knownAt<validAt, same-game self-update, outcome-in-input, structural/malformed; partition; missing vs observed_zero preserved
npx tsx server/pregameTargets/posteriorState/recencyWeights.test.ts # Pregame Targets PR1 — §5B weight product: season decay (current>prior-1>prior-2, rollover→0), role decays faster than skill, continuity floor, fail-safe clamping
npx tsx server/pregameTargets/posteriorState/posteriorState.test.ts # Pregame Targets PR1 — posterior sufficient stats: ESS=(Σw)²/Σw², weighted mean/variance, idempotent lineage, no-self-update, rolling-window rollover, ESS-boundary prior shrinkage
npx tsx server/pregameTargets/replay/liveReplayParity.test.ts # Pregame Targets PR1 — live vs replay byte-identical reconstruction via the shared as-of read path; monotonic corrections; deterministic tie-break
npx tsx server/dbMigrations/pregameTargetsFoundationPersistence.test.ts # Pregame Targets PR1 — foundation schema bootstrap: idempotence, IF-NOT-EXISTS-only, required indexes by name, no destructive SQL, failure propagates
npx tsx server/dbMigrations/pregameTargetsProvenancePersistence.test.ts # Pregame Targets PR2 — persisted_plays official-target provenance columns (surface/projection_snapshot_id/decision_snapshot_id/target_tier/role_certainty): additive ADD COLUMN IF NOT EXISTS self-heal, nullable/no-default, persisted_plays-only, no destructive SQL, idempotence, failure propagates
npx tsx shared/pregameTargets/projectionContract.test.ts # Pregame Targets PR2 (C6) — projection-blind contract: confidenceMarginPp=100×(p−0.5) in [-50,50] (NOT EV, price-independent, fail-safe), over/under complement coherence, probability/margin integrity, blindness guard rejects any price/EV/odds/line/edge/impliedProb/sportsbook/payout field — RECURSIVELY (nested objects/arrays), case- and separator-insensitive, cycle-safe, no substring false positives
npx tsx server/engines/nbaPregame/markets.test.ts # Pregame Targets PR3 — NBA launch market registry: 8 markets, combo→component decomposition, standalone threes never a combo component, documentation-only push/OT flags (NO line, NO push computation)
npx tsx server/engines/nbaPregame/math/pmf.test.ts # Pregame Targets PR3 — line-free count-PMF primitives: NB PMF (overdispersed), mixture, independent convolution, tail-fold normalization, moments; NO computeLineProbabilities/OVER-UNDER/EV; impossible states throw
npx tsx server/engines/nbaPregame/joint/pointsReboundsAssistsJoint.test.ts # Pregame Targets PR3 — (pts,reb,ast) joint via shared latent factor: joint sums to 1, marginalizing reproduces each component marginal, mean/variance preserved, available-subset build, fail-closed
npx tsx server/engines/nbaPregame/joint/comboDerivation.test.ts # Pregame Targets PR3 — combos read off joint states (== explicit joint-state summation, != separated-marginal convolution); combo mean = Σ component means; combo variance includes covariance; covariance positive and its magnitude tracks the latent variance
npx tsx server/engines/nbaPregame/minutes/teamMinutesAllocator.test.ts # Pregame Targets PR3 — team minutes allocator: two-stage bounded water-filling (240 regulation from projectedMinutesIfActive @cap 48, then INCREMENTAL 25·n OT from otParticipation @cap 48+5n — OT additive, never rewrites regulation), conservation Σ E[minutes]=240+25·E[OT] asserted on the REAL allocator + hard postcondition, DNP atom distinct from role variance, OT as probability mass, bounds, deterministic, fail-closed on infeasible roster
npx tsx server/engines/nbaPregame/statPosterior.test.ts # Pregame Targets PR3 — posterior→rate bridge: per-minute rate from PR1 sufficient stats, prior-shrunk, mixed over minutes ONCE (no double count), overdispersed game total; prior_dominant still projects; genuine absence/invalidity → typed unavailable
npx tsx server/engines/nbaPregame/frozenNbaProjectionInput.test.ts # Pregame Targets PR3 — frozen input + canonical hashing: feature hash (input) vs projection hash (output) distinct, envelope excluded, explicit -0/NaN/Inf/undefined serialization, deep freeze, byte-identical output for byte-identical input, fail-closed on a forbidden price/EV key
npx tsx server/engines/nbaPregame/nbaProjectionEngine.test.ts # Pregame Targets PR3 — engine + fail-closed boundary: full-data projection of all 8 markets; expected missing data → typed per-market unavailable (no throw); corruption DETECTED (core throws, safeComputeNbaProjection catches → all-unavailable + typed diagnostic)
npx tsx server/engines/nbaPregame/flags.test.ts # Pregame Targets PR3 — shadow flag parser (scaffolding only, no runtime wiring): fail-closed default off, exact affirmatives only, public-implies-shadow
npx tsx server/engines/nbaPregame/blindness.test.ts # Pregame Targets PR3 — blindness: frozen INPUT and full engine OUTPUT carry no line/odds/book/price/edge/EV/payout/implied/sportsbook key at any depth (recursive/aliased/array-nested/cycle-safe); checkProjectionBlindness sees no price/EV field on either
npx tsx server/engines/nbaPregame/determinism.test.ts # Pregame Targets PR3 — determinism + projection-hash invariance to decision-layer data: byte-identical output+hashes for identical modeling input, projection hash recomputable from ONLY the blind output, envelope invariance, modeling-input sensitivity
npx tsx server/engines/nbaPregame/decision/lineProbabilities.test.ts # Pregame Targets PR4 — coherent line probabilities from the frozen PR3 PMF: integer-line push, half-line zero-push, OVER/UNDER complementarity (over+under+push=1), pNoPushWin denominator (=1−push) behavior, tail-folded boundary resolvable flag, opposite sides from ONE PMF (never contradictory); no EV/odds/price
npx tsx server/engines/nbaPregame/calibration/walkForwardCalibration.test.ts # Pregame Targets PR4 — walk-forward calibration: STRICT as-of isolation (future obs with knownAt≥asOf never leak; knownAt==asOf excluded; same obs count once asOf advances), per-market/model provenance, documented identity fallback (insufficient evidence / invalid input), quality report by market+bucket (predicted vs empirical, ECE)
npx tsx server/engines/nbaPregame/decision/freshLineDecision.test.ts # Pregame Targets PR4 — fresh-line decision boundary: canonical identity verification before line eval, missing/malformed/future/stale line rejection, market-unavailable (incl. combo w/ missing component), not-resolvable folded-tail, complementarity-preserving calibration (UNDER=1−OVER), PR3 stays blind (hashes unchanged, no line field on projection), determinism; fail-closed typed status, never throws
npx tsx server/engines/nbaPregame/decision/pr4Isolation.test.ts # Pregame Targets PR4 — structural isolation: decision+calibration layers import no other sport engine (mlb/nba/ncaab) and no route/persistence/client/UI; compute no odds/EV/price/payout; PR3 projection stays blind after a decision; decision carries a line (+ sportsbook provenance label) but no pricing key
```

Railway runs the configured start command on each deploy; for local development run `npm run dev` and restart the dev server after server changes.

---

## 2. Stack

- **Frontend:** React + Vite, Tailwind, shadcn/ui, TanStack Query v5, wouter
- **Backend:** Express (TypeScript via `tsx`)
- **DB:** PostgreSQL with Drizzle ORM
- **Auth:** JWT + role-based access (`requireAuth`, `requireAdmin`, `requirePlayAccess`, `requireMLBAccess`, `requireTier`)
- **Notifications:** Twilio (SMS), Resend (email), web push
- **Payments:** Stripe (credentials supplied via Railway env vars; was a Replit-managed integration — do not re-install)
- **PWA:** custom service worker in `client/public/sw.js`

---

## 3. Architecture — Core Invariants

### 3.1 Engine isolation
NBA, MLB, NCAAB engines live in `server/engines/`, `server/mlb/`, `server/nba/`, `server/ncaab/` — fully isolated. **No shared calculation logic.** Files in one sport must not import from another sport. Phase 3B regression test enforces this for MLB.

### 3.2 MLB engine layering (do not collapse)
`Phase 1 → 1.5 → 2 → 2.5 → 3B` — each layer has a strict job:
- **Phase 1:** canonical sided probability
- **Phase 1.5:** caps bind **above** wrappers (e.g. `hits_allowed` UNDER cap=74 still clamps even if 3B wrapper would push higher)
- **Phase 2:** derive `signalTier` from `confidenceTier`
- **Phase 2.5:** near-HR contact detection (`nearHrContact.ts`) and HR Watch context fire; pitch-mix × handedness multiplier (`computePitchMixMatchupScore`), HR timing component (`computeHrTimingComponent`), and pitcher entry fatigue score (`computePitcherEntryFatigueScore`) are applied to HR markets here
- **Phase 3B:** math nudges (HRR compression, hits_allowed shift) **and** signal-composition nudges (HR Watch +3/+6 to `signalScore` only)

> Engine probability is **never** mutated by signal-composition layers.

### 3.2a HR Radar canonical state machine
`hrRadarStateMachine.ts` owns the **pure transition graph** for HR Radar lifecycle: `inactive → watch → build → ready → fire → cashed|missed|model_review|expired`. Terminal states are sticky. `hrRadarCanonicalStore.ts` owns in-memory persistence. `hrRadarSection.ts` provides section/outcome helpers for the API layer. `nonHrSignalState.ts` mirrors the same pattern for non-HR markets (`BUILDING → ACTIVE → COOLING → CLOSED`). No UI component may derive lifecycle state — all read from server-stamped values.

### 3.2a-1 MLB Live Edge is event-driven, never clock-driven
**Time detects events. Events drive computation. Signal state drives sportsbook refreshes.**
- `server/mlb/liveStateEvents.ts` is the pure classifier (`classifyStateChange`,
  `computeImpactedMarkets`, `affectedActors`). `LiveGameOrchestrator.detectStateChange` delegates to it.
- **A pitch-count increase is NOT contact.** `ball_in_play` comes from `GameStateCache.battedBallEvents`
  (play-feed `details.isInPlay`/`hitData`), never from a `pitchCount` delta. A missing counter means
  "unknown", never "yes".
- **A no-change poll terminates immediately** — no engine run, no HR evaluation tick, no odds request.
  The only exception is the 150s *reconciliation check* (`RECONCILE_BACKSTOP_MS`): re-diff current state
  against `lastEngineStates` (the state the engine last actually ran on, distinct from `previousStates`),
  and run the engine only if that diff contains real missed events. It is a check, not a recompute.
- Pitch-count deterioration uses canonical threshold **crossings** `[50,65,75,85,95,105]` — 74→75 fires,
  75→76 does not. Do not add thresholds.
- `computeImpactedMarkets` applies **market-family closure** so `applyFamilySuppression` can never see a
  split family (e.g. `runner_change` pulls in `home_runs` alongside `total_bases`).
- `LAST_RUN` dedup is **scope-aware** — a narrow cycle can never swallow a wider one behind it.
- Narrowed cycles carry forward untouched signals via `server/mlb/edgeCarryForward.ts`. The carry
  predicate is **scope, not absence**: an in-scope pair producing no fresh signal is a real deletion.
  Carried objects pass through by reference and never re-enter family suppression, `autoPersistMLBSignals`,
  the LiveSignalBus loop, or `recordDriftSnapshot`.
- **`home_runs` is never narrowed by player** — `consecutivePromoteTicks` is evaluation-counted and the
  presence-floor pass assumes a full-lineup walk.
- Polling priority never keys off an inning *number* (`MLB_TRIGGER_INNINGS` was removed); an inning
  *transition* is the event.

### 3.2b MLB odds cache (Live Edge) — engine ticks never fetch
MLB Live Edge is narrowed to three books (`draftkings,fanduel,hardrockbet` — `MLB_PROP_BOOKMAKERS` in `server/oddsService.ts`, `PREFERRED_BOOKS_BY_SPORT.mlb` in `server/odds/oddsConfig.ts`; `FALLBACK_BOOKS_BY_SPORT.mlb` is intentionally empty). The narrowing is applied to the **request** (`bookmakers=` param), not as a post-fetch filter — fetching ten books and discarding seven spends the same upstream quota. This is **MLB-only** — NBA keeps its own separate `PROP_BOOKMAKERS`/book lists untouched.
- **Active-polling price floor (`server/odds/mlbOddsPriceFloor.ts`) is SIDE-SPECIFIC.** A market/side is
  eligible for routine refresh only when the best approved-book American price **on the side the engine is
  evaluating** is `>= -200` (-200 eligible, -201 not). The opposite side can never rescue it: OVER at
  DK -225 / FD -210 / HRB -215 stays suppressed even with UNDER +175 available. Unknown pricing gets exactly
  one discovery request. The evaluated side is stamped per cycle by `recordEvaluatedSide` (defaults to OVER).
- **Dormancy, not abandonment.** A sub-floor market parks as dormant with no routine refresh. Material
  baseball events (`inning_change`, `pitcher_change`, `lineup_substitution`) grant it exactly one
  rediscovery opportunity via `reconsiderDormantMarkets` — there is deliberately **no** second timer.
- **Refresh urgency follows the existing canonical lifecycle state**, not a parallel state machine:
  watch→`monitoring` (cached odds only), build→`build` (stale-only), strong→`ready` (45s),
  elite→`actionable` (30s + immediate on promotion).
- **Engine recomputation never implies a provider request.** `resolveBookLine` reads cache unconditionally;
  whether it additionally registers refresh interest is a separate decision gated on the price floor,
  lifecycle urgency, and whether a real baseball event authorized the cycle.
- **One raw cache key per event+market, no player/live/pregame dimension:** `mlb_odds:${eventId}:${marketKey}` (`getMLBRawOdds` in `server/oddsService.ts`). No `in_play` param is ever sent to the provider. A single-flight `Map<string, Promise<...>>` collapses concurrent callers for the same key into one provider request.
- **Freshness is status-based, not TTL-based, and never itself triggers a fetch:** `isMLBSnapshotFresh(gameStatus, ageMs)` — pregame=2min, live=30s, final=immutable (always fresh), unknown=cache-only (never confirmed fresh). A snapshot can be stale without that stale-ness causing a provider call.
- **The engine tick never calls fetch().** `resolveBookLine()` in `server/mlb/liveGameOrchestrator.ts` reads via `readMLBPlayerOddsFromCache(eventId, playerName, market, gameStatus)` (cache-only, pure) and registers refresh interest with the independent coordinator — fire-and-forget, never awaited. `triggerEngine()` resolves the odds event ID via the cache-only `resolveMLBOddsEventIdFromCache`, never the fetching `resolveMLBOddsEventId`.
- **Refresh is interest-driven**, not a blanket per-tick sweep: `server/odds/mlbOddsRefreshCoordinator.ts` (deliberately separate from `oddsScheduler.ts`, which stays game-state-polling-only). Dedup by `eventId:market`. Watched=2min cadence, near-actionable (live + stale)=30s with an immediate fire on promotion. `final` status removes all scheduled interest for that event.
- A derived per-player snapshot cache (`server/odds/oddsCache.ts`, keyed by event+market+**player**) still exists for presentation/last-known-good display — that layer is unrelated to the provider-response cache above and was not narrowed.

### 3.2c MLB Live Edge safety-core — production lane (Stage A) — fail-closed
A 7-day sample (-35.28u; innings 1-3 = -70.58u; TB/pitcher_outs/HRR/hits_allowed all negative)
proved several older Goldmaster clauses wrong. Stage A adds a **production-lane authority**
(`server/mlb/mlbProductionLane.ts`) layered on top of — never replacing — base eligibility
(`mlbOfficialEligibility.ts`, its locked contract unchanged). `lane === "official"` is strictly
NARROWER than `officialEligibility.eligible`: a signal reaches the official lane only when it is
base-eligible AND clears the market rollout mode + inning band (`productionPolicy.ts`), the
market-specific **hard evidence invariants** (`marketEvidenceInvariants.ts`), a fresh
same-book/same-line **no-vig** price floor (`oddsProbability.ts`), a probability floor, the
integer-line-push gate, and the calibration/provisional gate. The finalizer stamps `lane` +
canonical no-vig edge; `autoPersistMLBSignals` and the `routes.ts` safety-net gate official
persistence on `lane === "official"` (fail-closed AND). **An empty official feed is legal.**

Default matrix: innings 1-3 never official; `hits` official (provisional_uncalibrated, stamped
`raw_provisional`, never Elite/Strong); `total_bases`/`hrr`/`pitcher_outs`/`hits_allowed`/
`pitcher_strikeouts` shadow. HR Radar is excluded (keeps its own lifecycle — its lane mirrors base
eligibility).

**Superseded clauses (do NOT restore):** `edge = displayProbability - 50` (edge is now calibrated
recommended-side prob − no-vig book prob, in pp, in `model_edge` + `edge_version`; legacy `edge_gap`
left null for new MLB rows); "empty official feed is illegal" (official fails closed);
static caps ARE NOT calibration; `signalScore` MUST NOT rank/qualify/promote an official play or set
its tier; pitcher OVER MUST NOT route through the UNDER family (`pitcher_over` family exists). When no
compatible calibrator exists, `calibratedProbability` is **null** (never an identity copy of raw).

### 3.3 The signal pipeline (single source of truth)
```
ENGINE  →  NORMALIZER  →  LiveSignalBus  →  Lifecycle Store  →  UI / Alerts
                              ↑ sole ingress
```
- `MLBSignal` is the engine output object.
- `applyDisplayContract` (in `server/mlb/normalizeSignal.ts`) stamps `displaySide`, `displayProbability`, `over/underProbability`, `displayGrade`, `isBettable`, `isWatchOnly`, `displayDrivers`. **Clients are forbidden from re-deriving these.** Mismatches log `[MLB_DISPLAY_CONTRACT_MISMATCH]`.
- `CanonicalSignal` (`shared/canonicalSignal.ts`) is the post-normalization transport contract. `lifecycleState` (watch/build/strong/elite/cashed/missed/expired) is **orthogonal** to `signalTier` (watch/lean/strong/elite). Stable signalId scheme: `${sport}:${gameId}:${actorId}:${market}:${side}`.
- `LiveSignalBus` (`server/services/liveSignalBus.ts`) is the **sole ingress**. It owns dedupe (by signalId only — never by player name or UI label), freshness, and propagation. It does **not** own engine math, lifecycle transitions, or rendering.
- Lifecycle engine (`server/services/lifecycleEngine.ts` + `lifecycleStore.ts`) owns transitions only. Allowed mutations: `lifecycleState`, `lifecycleHistory`, `surfacedAt`, `updatedAt`, `expiresAt`, `suppressionReason`, `expirationReason`, `gradingLink`. **Forbidden:** anything else.
- `IMMUTABLE_FIELDS` in `shared/canonicalSignal.ts` is enforced by `signalMutationGuard.ts` — tampering logs `[LL_SIGNAL_MUTATION_DETECTED]`.

### 3.4 Eastern Time dominance
All server-side date logic must use `todayET()` (America/New_York). Late-night games will be off-by-one-day if you reach for `new Date()`.

### 3.5 Drivers + explainability
`SignalDriver` (`shared/signalDrivers.ts`) is built **server-side from real evidence only** (engine `displayDrivers`, `hrAlert.positiveDrivers`, `smartTags`, `scoreBreakdown`). The UI renders verbatim and is **forbidden from inventing or transforming drivers** beyond display formatting.

### 3.6 Analytics layer (Batch E)
`server/analytics/` is **read-only**. It taps lifecycle/alert/shadow/HR-Radar emit sites, appends to an in-memory ring buffer, and rolls up periodic snapshots for the admin dashboard. It must **never** mutate the engine, the bus, or any canonical field.

### 3.7 Shadow qualification
`server/mlb/shadowQualification.ts` runs a parallel lower-floor signal track for batter-over markets. It writes **only** to its shadow store — never to `storage.settlePlay`, `persisted_plays`, ROI, or W/L. Push outcomes are excluded from hit rate. ROI proxy at -110 vig (cashed=+0.909u, missed=-1u). Sample-size warning when settled<50.

### 3.8 MLB Recommendation Episode contract (Flagship Program Phase 1 foundation)
A NEW, product-agnostic contract shared by Plate/Mound/Live Edge for **official** MLB recommendations — distinct from `persisted_plays` (mutable, cross-sport, upsert-in-place "current best" row) and `CanonicalSignal` (live-only, 0-100 display probability). `shared/mlbRecommendationEpisode.ts` defines `MlbRecommendationEpisode`: a frozen record (side/line/price/sportsbook/probability/projection/model+contract version) plus a small mutable lifecycle surface (`surfacedAt`/`expiresAt`/`lifecycleStatus`/`status`/`settlementResult`/`settledAt`), guarded by `applyMlbEpisodeLifecycleEvent` (throws on any attempt to mutate a frozen field, an invalid status transition, or any patch to a terminal episode) and `settleMlbRecommendationEpisode` (grades the episode's own frozen side/line/price; settlement is single-write). Persisted in `mlb_recommendation_episodes` (`shared/schema.ts`, bootstrap in `server/dbMigrations/mlbRecommendationEpisodePersistence.ts`) via `IStorage`'s `createMlbRecommendationEpisode` (INSERT-only, never upserts a frozen row) / `getMlbRecommendationEpisode` / `listMlbRecommendationEpisodes` / `applyMlbEpisodeLifecycleEvent` / `settleMlbRecommendationEpisode` (`server/storage.ts`).

`server/mlb/episodes/mlbOfficialRecommendationFirewall.ts`'s `evaluateOfficialRecommendationEligibility` is the single gate a candidate must clear before it may become `isOfficial: true` — approved sportsbook only (`draftkings`/`fanduel`/`hardrockbet`; rejects placeholder labels like `"odds_api"`), finite line/price, real fetch timestamp, freshness computed from the **reader's current game status** (never a stored value — see `server/odds/mlbOddsProvenanceContract.ts`'s `classifyMlbOddsFreshness`, which wraps `isMLBSnapshotFresh` rather than re-deriving its TTLs), side/projection/probability mathematical consistency, and required model/contract version. `server/mlb/episodes/mlbEpisodeMeasurement.ts` computes performance (win rate, units/ROI from each episode's own captured American odds — never a flat -110 assumption, Brier score, log loss, expected calibration error, coverage, CLV when closing prices are supplied) purely from arrays of frozen, `isOfficial: true` episodes, with breakdowns by product/market/side/setupGrade/modelVersion/gamePhase/dataQuality. `shared/mlbEmptyStateReason.ts` gives empty pregame/live feeds an explicit, user-safe reason code instead of a generic "no plays."

**Status: contracts + firewall + measurement + persistence are defined and unit-tested; no product (Plate/Mound/Live Edge) writes episodes into this table yet** — wiring each product to emit real episodes is later-phase work. Do not create a second/duplicate version of this contract.

### 3.9 Mound Radar V2 (shadow, research-only)
`server/mlb/pregame/mound/v2/` builds a genuine outcome **probability distribution** for pitcher strikeouts and outs recorded — distinct from production `score10` (a matchup-quality composite, never a probability; see `scoring.ts`). Per-batter P(strikeout) (`batterStrikeoutProbability.ts`) blends the pitcher's own platoon K rate with each individual opposing batter's shrunk K rate in log-odds space (same style as production `opponentKProfile.ts`'s lineup-aggregate blend, applied per batter instead). A batters-faced workload distribution and a separately-modeled outs-recorded workload distribution (`battersFacedWorkloadModel.ts`, both negative-binomial, mean from `avgInningsPerStart` adjusted for pitch-count efficiency and walk rate, variance from `ipVarianceLast3`) feed `moundV2Engine.ts`'s `computeMoundV2Distribution`, which mixes a Poisson-binomial strikeout distribution (conditional on each plausible batters-faced count, cycling the confirmed batting order) across that workload marginal — real OVER/UNDER/push probabilities and an expected value, for both markets. `moundV2PromotionGate.ts` defines (but never applies) the promotion bar: sample size, calibration/Brier/log-loss improvement vs. baseline, market coverage, and a hard block on any settlement/provenance regression.

**Shadow-only, structurally enforced**: nothing under `mound/v2/` is imported by `buildMlbMoundRadar.ts`, `scoring.ts`, `moundDirection.ts`, `moundOutcomeAttribution.ts`, `evaluationSnapshot.ts`, `moundGradedStateCarry.ts`, or any `storage.ts` mound method (verified by grep + a test-time structural check) — `score10`/`tier`/`primaryMarket`/settlement are completely untouched. Nothing here is persisted yet; there is no capture/grading pipeline wiring V2 predictions to real outcomes — that, and any future promotion, are later work. Do not wire V2 into production without clearing `moundV2PromotionGate.ts`'s criteria first.

---

## 4. Where Things Live

| Concern | Path |
| --- | --- |
| Shared schemas | `shared/schema.ts` |
| API contracts | `shared/routes.ts` |
| Canonical signal contract | `shared/canonicalSignal.ts`, `shared/signalDrivers.ts` |
| MLB engine | `server/mlb/signalScore.ts`, `server/mlb/markets.ts`, `server/mlb/probabilityEngine.ts` |
| MLB normalizer + display contract | `server/mlb/normalizeSignal.ts` |
| MLB odds cache (Live Edge, unified raw cache + single-flight + status-based freshness) | `server/oddsService.ts` (`getMLBRawOdds`, `readMLBPlayerOddsFromCache`, `isMLBSnapshotFresh`), `server/odds/mlbOddsRefreshCoordinator.ts` (interest-driven refresh, independent of `oddsScheduler.ts`), `server/odds/oddsConfig.ts` (`PREFERRED_BOOKS_BY_SPORT`/`FALLBACK_BOOKS_BY_SPORT`) |
| MLB signal bus + lifecycle | `server/services/liveSignalBus.ts`, `server/services/lifecycleStore.ts`, `server/services/lifecycleEngine.ts` |
| MLB HR Radar engine | `server/mlb/hrAlertEngine.ts`, `server/mlb/hrRadarUserStage.ts`, `server/mlb/hrConversionModel.ts` |
| MLB HR Radar state machine | `server/mlb/hrRadarStateMachine.ts`, `server/mlb/hrRadarCanonicalStore.ts`, `server/mlb/hrRadarSection.ts`, `server/mlb/hrRadarOutcomeStamp.ts` |
| MLB near-HR contact detector | `server/mlb/nearHrContact.ts` (Phase 2.5, pure function — no I/O) |
| MLB non-HR signal state engine | `server/mlb/nonHrSignalState.ts` (BUILDING→ACTIVE→COOLING→CLOSED) |
| MLB live event interpretation | `server/mlb/liveEventInterpretation.ts` |
| MLB integrity firewall | `server/mlb/integrityFirewall.ts` |
| MLB shadow qualification | `server/mlb/shadowQualification.ts` |
| MLB HR miss diagnostics (LLM payload, read-only) | `server/mlb/hrMissDiagnostics.ts` (pure builders), `server/mlb/hrMissDiagnosticsService.ts` (DB gatherer), `client/src/components/admin/HrMissDiagnosticsCard.tsx` (admin card) |
| MLB Plate champion/challenger model contract | `server/mlb/pregamePowerRadar/modelVersions/` — `plateChampionJul20.ts` (`plate_jul20_restored_v1`, production authority, hard-coded), `plateChallengerCurrent.ts` (`plate_current_shadow_v1`, shadow only), `plateDriverUniverse.ts` (JUL20/CURRENT_HEAD/RESEARCH_ONLY key sets), `platePublicationDecision.ts` (the single publication authority), `plateShadowFlags.ts` (fail-closed `PLATE_SHADOW_CHALLENGER_ENABLED`); `frozenPlateInput.ts` (immutable hashed DTO both models share), `evaluatePlateModel.ts` (required policy arg), `plateModelComparison.ts`, `plateModelComparisonStats.ts`, `scripts/comparePlateModels.ts` |
| MLB Pre-Game Power Radar + Win Attribution | `server/mlb/pregamePowerRadar/` — `shadowOutcomes.ts` (grading + `pregame_win`/`calibration_miss` attribution + public/admin stat getters), `winAttribution.ts` (pure attribution + daily-log builders), `calibrationStats.ts` (pure public/admin stat builders), `scoring.ts` (6-component weighted composite), `nearHrRecentForm.ts` (Component 6 — retroactive near-HR contact form via `nearHrContact.ts`, last 3 ET days, recency-weighted + consecutive-day bonus), `shared/pregameRadarWin.ts` (transport contracts: `DailyCashedLogResponse`, `PregameRadarPublicStats`, `PregameRadarCalibrationStats`); client `PregameWinCard.tsx` (public record + wins) + `components/admin/PregameRadarCalibrationCard.tsx` (admin calibration) |
| MLB orchestrator (per-tick driver) | `server/mlb/liveGameOrchestrator.ts` |
| Goldmaster lock + drift guard | `server/mlb/goldmasterGuard.ts` |
| MLB qualification audit + market-starvation guard | `server/mlb/qualificationAudit.ts` (passive rejection/qualification recorder, feeds `/api/admin/mlb-qualification`), `server/mlb/marketStarvationGuard.ts` (per-market staleOdds threshold guard, log-only), `client/src/components/admin/MlbQualificationAuditCard.tsx` (admin card) |
| MLB Recommendation Episode contract (Flagship Program Phase 1) | `shared/mlbRecommendationEpisode.ts` (frozen contract + guarded mutator), `shared/mlbOddsProvenance.ts`, `shared/mlbEmptyStateReason.ts`, `shared/mlbPerformanceMeasurement.ts` (transport shapes); `server/odds/mlbOddsProvenanceContract.ts` (Zod + reader-driven freshness), `server/mlb/episodes/mlbOfficialRecommendationFirewall.ts` (official-publication gate), `server/mlb/episodes/mlbEpisodeMeasurement.ts` (pure ROI/Brier/log-loss/calibration math); persistence in `shared/schema.ts` (`mlbRecommendationEpisodes`), `server/dbMigrations/mlbRecommendationEpisodePersistence.ts`, `server/storage.ts` (`createMlbRecommendationEpisode` et al.) |
| Mound Radar V2 (Flagship Program Phase 2, shadow-only) | `server/mlb/pregame/mound/v2/moundV2Math.ts` (Poisson-binomial/negative-binomial primitives), `batterStrikeoutProbability.ts`, `battersFacedWorkloadModel.ts`, `moundV2Engine.ts` (`computeMoundV2Distribution`), `moundV2PromotionGate.ts` (criteria checker, never auto-applied) — zero production Mound import edges |
| Cross-Radar (Mound→Plate target suggestions) | `server/mlb/pregame/composition/moundPlateTargets.ts` (pure join/rank/dedupe builder — assumes its Plate input is already publication-filtered), `composition/enrichMoundResponse.ts` (applies Plate's own canonical `isPublicPregameSignal` gate, then wraps an ALREADY-BUILT `MoundRadarResponse` — never invoked from inside `buildMoundResponse`), `composition/loadPregameCompositionContext.ts` (Plate snapshot loader via the existing non-blocking `peekRadarSnapshot` + `MOUND_PLATE_TARGET_SUGGESTIONS_ENABLED` rollout flag, off by default), `composition/composeMoundResponse.ts` (route-level orchestration: canonical `buildMoundResponse` first, composition after, fail-closed to `[]` on any Plate error, one bounded `[MOUND_PLATE_COMPOSITION]` log per response). `server/mlb/pregame/mound/types.ts` and `diagnostics.ts` are untouched by this feature — no Plate types, no Plate/composition imports, unchanged `buildMoundResponse` signature and output. Triggered solely by the pre-existing `cr_high` driver (`mound/contactRisk.ts`'s `hasHighContactRisk`) |
| NBA playoff rotation truth | `server/services/nbaRotationHistoryService.ts` |
| Analytics (read-only) | `server/analytics/` |
| HR Board Studio (admin growth, read-only) | `server/growth/hrBoardStudioCore.ts` (pure builders), `server/growth/hrBoardStudioService.ts` (live gatherers), `server/growth/hrBoardStudioRoutes.ts`, `server/growth/hrBoardCompliance.ts`, `server/growth/hrBoardAnalytics.ts`, `shared/hrBoardStudio.ts`, `client/src/components/admin/HrBoard*.tsx`, `client/src/pages/admin/hr-board-studio.tsx` |
| Alerts | `server/services/alertSubscriber.ts` |
| Auth | `server/auth.ts` |
| Storage interface | `server/storage.ts` |
| Routes (API) | `server/routes.ts` |
| Boot / cron / sweepers | `server/index.ts` |
| Admin pages | `client/src/pages/admin.tsx`, `client/src/pages/admin/*.tsx` |
| Unified analytics panel | `client/src/components/unified-analytics.tsx` |
| Agent specs | `docs/agents/{nba-agent,mlb-agent,mlb-lock-standard,mlb-guardrail-agent,mlb-reset-skill,mlb-goldmaster-prd}.md` |
| Signal engine reference | `docs/SIGNAL_ENGINE_REFERENCE.md` |

---

## 5. Diagnostic Tags (the truth lives in logs)

The codebase emits one-line bracketed tags as the primary observability surface. Familiar prefixes when debugging:

- **Bus:** `[LL_SIGNAL_REGISTER]`, `[LL_SIGNAL_UPDATE]`, `[LL_SIGNAL_DEDUPE]`, `[LL_SIGNAL_REJECTED]`, `[LL_SIGNAL_EXPIRED]`, `[LL_LEGACY_SIGNAL_CONSUMER]`
- **Lifecycle:** `[LL_SIGNAL_CREATED]`, `[LL_SIGNAL_UPGRADED]`, `[LL_SIGNAL_DOWNGRADED]`, `[LL_SIGNAL_CASHED]`, `[LL_SIGNAL_MISSED]`, `[LL_LIFECYCLE_INVALID_TRANSITION]`, `[LL_LIFECYCLE_SWEEP]`
- **Mutation guard:** `[LL_SIGNAL_MUTATION_DETECTED]` ← **must never fire in healthy runtime**
- **Display contract:** `[MLB_DISPLAY_CONTRACT_MISMATCH]` ← also must never fire
- **HR Radar:** `[HR_RADAR_TRANSITION]`, `[HR_RADAR_READY]`, `[HR_RADAR_FIRE]`, `[HR_RADAR_INACTIVE]`
- **Shadow:** `[LL_SHADOW_SIGNAL_QUALIFIED]`, `[LL_SHADOW_OUTCOME_RESOLVED|MISSING|PUSH|EXPIRED]`, `[LL_SHADOW_SIGNAL_CASHED|MISSED]`
- **Goldmaster:** `[MLB_GOLDMASTER_LOCK]` (boot), `[MLB_SIGNAL_PARITY]` (per cycle), `[MLB_DRIFT_WARNING]`
- **Live Edge polling/odds:** `[MLB_STATE_EVENT]`, `[MLB_ENGINE_TRIGGER]`, `[MLB_ODDS_REFRESH]`, `[MLB_ODDS_CACHE_HIT]`, `[MLB_ODDS_PRICE_SUPPRESSED]`, `[MLB_ODDS_DORMANT]`, `[MLB_ODDS_REACTIVATED]`, `[MLB_CARRY_FORWARD]`, `[MLB_POLLING_METRICS]` (aggregate, ≤1 per 5 min) — all rate-limited; there is deliberately no per-pitch logging
- **Qualification:** `[MLB_MARKET_STARVED]` / `[MLB_MARKET_STARVED_RECOVERED]` — a market's rolling-window staleOdds rejectRate crossed/cleared the starvation threshold (missing sportsbook lines, not engine drift)
- **Alerts:** `[LL_ALERT_QUEUED]`, `[LL_ALERT_SENT]`, `[LL_ALERT_DEDUPE]`, `[LL_ALERT_SUPPRESSED]`, `[LL_ALERT_OPENED]`, `[LL_ALERT_CLICKED]`
- **Analytics:** `[LL_ANALYTICS_AGGREGATE]`, `[LL_ANALYTICS_HR_RADAR]`, `[LL_ANALYTICS_DRIVER]`, `[LL_ANALYTICS_SHADOW]`
- **PWA:** `[LL_PWA_REFRESH]`, `[LL_PWA_CACHE_INVALIDATE]`, `[LL_NOTIFICATION_ROUTE]`

---

## 6. Admin Endpoints

All gated by `requireAdmin`. Distinct namespaces:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/admin/signal-bus` | Bus runtime metrics, legacy-consumer counts, propagation P50/P95 |
| `GET /api/admin/signal-lifecycle` | Paginated CanonicalSignal list (`?sport=mlb&limit=N`) |
| `GET /api/admin/signal-lifecycle/:signalId` | Full record with `lifecycleHistory[]`, `gradingLink`, etc. |
| `GET /api/admin/mlb-qualification` | Rolling-window qualification audit |
| `GET /api/admin/mlb-live-edge-metrics` | Live Edge polling/odds spend — state polls, no-change polls, material events, engine runs by trigger, refresh attempts vs. skips (fresh-cache / price-floor / no-event), dormancy, and external Odds API requests per live game-hour |
| `GET /api/admin/mlb-shadow-qualification` | Shadow outcome breakdown + ROI proxy |
| `GET /api/admin/mlb-signal-intelligence` | Batch E unified dashboard payload |
| `GET /api/admin/hr-board-studio/today` | Today's ranked Pre-Game HR board rows |
| `POST /api/admin/hr-board-studio/generate-pack` | Generate no-link content pack (does not post anywhere) |
| `GET /api/admin/hr-board-studio/movement-feed` | Pre-game board players who moved into live HR Radar stages |
| `POST /api/admin/hr-board-studio/generate-recap` | Generate postgame recap/proof assets for a date |
| `POST /api/admin/hr-board-studio/log-action` | Record admin copy/download/generate/view analytics |
| `GET /api/admin/hr-board-studio/analytics` | Admin workflow summary rollup |
| `GET /api/admin/mlb/plate-model-comparison` | Plate champion vs challenger (`?date=` or `?from=&to=`) — sticky-exposure A/B, HR and TB tracked separately, attribution breakdown, lost/gained winners. Admin-only, no public surface |
| `GET /api/admin/mlb/pregame-radar/calibration` | Pregame Radar calibration breakdown (`?days=N`) — full denominator (wins + calibration misses), byTier/byScoreBand/byDriver + conversion rates |
| `GET /api/admin/hr-radar/miss-payload` | HR Miss Diagnostic Payload — LLM-ready miss dossier (`?days=N&limit=N&categories=csv&format=json\|markdown`): fired/ready-only false positives + uncalled/late false negatives with engine snapshots, review buckets, and signal timelines |

Admin pages live under `/admin`, `/admin/mlb-signal-intelligence`, `/admin/track-record`, and `/admin/hr-board-studio`.

---

## 7. Hard Rules — DO NOT

1. **Do not** mutate `IMMUTABLE_FIELDS` of a `CanonicalSignal` after it leaves the bus (probability, side, market, signalTier, signalScore, drivers, triggerSummary).
2. **Do not** add a new ingress path for signals — `LiveSignalBus.registerSignal` is the only entry point.
3. **Do not** dedupe by player name, market label, or UI string. Dedupe is `signalId`-only.
4. **Do not** re-derive `displaySide`, `displayProbability`, `displayGrade`, or `isBettable` on the client. Read from the server-stamped values.
5. **Do not** mutate engine probability from a signal-composition layer (HR Watch may bump `signalScore` only). *Engine-math changes that improve probability are allowed **inside the engine layer itself** (e.g. `hrConversionModel.ts`, `probabilityEngine.ts`) — see §7a; the prohibition is on composition/normalizer/lifecycle/bus layers reaching back and rewriting it.*
6. **Do not** import across sport engines (`server/mlb` ↔ `server/nba` ↔ `server/ncaab`).
7. **Do not** edit `package.json` directly — use the package management tools, and never modify Vite / Drizzle config without strong cause.
8. **Do not** add analytics code paths that mutate runtime state. Analytics are read-only and wrapped in `try/catch` so they can never break runtime.
9. **Do not** use `new Date()` for slate / window logic — use `todayET()`.
10. **Do not** display or write secret values. Use Railway-managed env vars.

---

## 7a. Sanctioned Engine Changes (improving behavior is allowed)

The Hard Rules above protect **structural integrity** (sole ingress, post-bus immutability,
cross-sport isolation, analytics read-only, ET dominance, secrets). They are **not** a freeze on
the model. **Intentionally changing engine math/behavior to improve accuracy — including HR
conversion probability, scoring thresholds, gates, and new predictive features — IS permitted**,
provided every change follows this discipline:

1. **Make the change in the right layer.** Probability/behavior changes live in the engine
   (`server/mlb/hrConversionModel.ts`, `evaluateHRAlert.ts`, `hrAlertEngine.ts`,
   `signalScore.ts`, `probabilityEngine.ts`, `nearHrContact.ts`) **before the bus**. Never via a
   composition/normalizer/lifecycle/bus/analytics layer (Hard Rules 1, 2, 5, 8 still hold).
2. **Keep new model inputs additive & no-op when absent** (return `1.0` / `+0` / `null`) so partial
   data never destabilizes runtime and regression fixtures stay green.
3. **Don't silently change the emitted payload shape.** New engine inputs/feature signals stay
   internal unless deliberately surfaced; a payload-shape change must be intentional (it trips the
   drift guard's `shape_change`).
4. **Cap probability effects** so a single feature can't swing the per-PA rate past existing clamps
   (Phase 1.5 caps still bind above all new multipliers).
5. **Re-baseline the goldmaster.** When engine behavior changes on purpose, bump
   `MLB_GOLDMASTER_VERSION` in `server/mlb/goldmasterGuard.ts` to document it — `[MLB_DRIFT_WARNING]`
   is then expected/acceptable transient noise, not a regression. "Drift" only means **unintended**
   change; a documented, re-baselined improvement is not drift.
6. **Run the regression suites** (§1) and add/adjust cases for the new behavior before merging.

In short: improvements are encouraged. The rules govern *how* (layer, caps, re-baseline,
test), not *whether*.

---

## 8. Common Gotchas

- **Stripe price IDs:** new subscriptions must use `price_1TJJ4M2ceUNmv10tYSsYXA6T` (Pro) and `price_1TJJ4M2ceUNmv10tB8JCzPYe` (All Sports). Legacy IDs are mapped in `server/billing/planMap.ts`.
- **MLB grading:** auto-graded HRs without prior alerts are excluded from the W/L record and marked "Uncalled HR".
- **NBA 2H plays:** must use `isNbaHalftimeWindow` and derived 2H lines — overly strict gating previously caused empty payloads.
- **HR Radar Ready section:** historically empty due to parallel scoring tracks; the `computeUnifiedCanonicalStage` collapse fixed this. Do not re-introduce a parallel track.
- **TanStack Query v5:** object form only — `useQuery({ queryKey: [...] })`, never positional. Use array query keys for hierarchical cache: `['/api/recipes', id]`.
- **Frontend env vars:** must be `VITE_` prefixed and accessed via `import.meta.env`. Never `process.env` on the client.
- **TypeScript iterators:** when iterating `Map.values()` / `Map.entries()`, wrap in `Array.from(...)` — the project's TS target requires it.
- **Forms:** use shadcn `useForm` + `Form` + `zodResolver` with insert schemas from `@shared/schema`. Provide `defaultValues`.

---

## 9. Working Conventions

- **Test IDs:** every interactive element gets `data-testid="{action}-{target}"` (e.g. `button-submit`); display elements get `{type}-{content}`; dynamic lists append a unique id.
- **File structure:** keep files modular — split JSX, CSS, and components into separate files. Maintain existing structure.
- **Toasts:** `useToast` is exported from `@/hooks/use-toast`.
- **Routing:** `wouter` everywhere — `Link` or `useLocation`, never modify `window.location` directly.
- **Storage:** every CRUD goes through the `IStorage` interface in `server/storage.ts`. Routes stay thin.
- **Validation:** Zod schemas from `drizzle-zod` validate every request body before it reaches storage.

---

## 10. References

- [Stripe Docs](https://stripe.com/docs)
- [Twilio Docs](https://www.twilio.com/docs)
- [Resend Docs](https://resend.com/docs)
- [Drizzle ORM](https://orm.drizzle.team/docs/overview/postgres)
- [TanStack Query](https://tanstack.com/query/latest)
- [Tailwind CSS](https://tailwindcss.com/docs)
- Internal: `docs/agents/`, `docs/SIGNAL_ENGINE_REFERENCE.md`, `replit.md`
