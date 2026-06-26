# Pre-Game Power Radar — v2 Future Phases (Deferred Work)

This task delivered the v2 **shadow** math framework, leakage contract, coverage
audits, pure helpers, and unit tests. Per the approved scope, anything requiring
**historical data or a backtest** was intentionally **not** implemented and is
documented here as future work.

## Explicitly NOT done in this task (by instruction)
- Historical backtesting / replay over past slates.
- Calibration of HR probability against realized outcomes.
- A database-backed backtest harness.
- Any synthetic or illustrative performance metric (no fabricated hit-rate / ROI / lift numbers).
- Historical ROI / hit-rate reporting.
- Any change to production scoring, tiers, labels, thresholds, HR Radar, live models,
  DB schema, or files outside `server/mlb/pregamePowerRadar/math/**` and `docs/audits/**`.

## Why deferred
The canonical outcome source (`pregame_power_radar_signals` with `outcomes.hitHr`,
joinable by `gameId + batterId + sessionDate`) requires a populated database. This
environment has **no `DATABASE_URL`** and no historical archive, so no real backtest
can run and no honest metric can be produced. Rather than fabricate numbers, the
work stops at a fully-tested, data-pluggable math core.

---

## Future Phase A — No-leak historical backtest
**Goal:** measure the v2 model against real outcomes.
- Read historical candidates from `pregame_power_radar_signals` (DB) over a date range.
- Join to HR outcomes by `gameId + batterId` using the row's own `outcomes.hitHr`.
- Reuse the leakage contract (`leakageGuard.ts`) to assert pre-first-pitch locking.
- Aggregate: tier hit-rate + monotonicity, top-3/5/10 slate hit-rate + lift, driver
  lift / false-positive rate, suppressor true/false removal, calibration buckets.
- **Read-only**: no DB writes, no production-snapshot mutation, no scoring change.
- Artifacts: JSON + Markdown under `docs/audits/`.
- **Precondition:** a populated DB (or an exported snapshot / `DATABASE_URL`).

## Future Phase B — Empirical calibration
**Goal:** make the probability calibrated, not just modelled.
- Fit an isotonic / Platt calibrator on backtest (predicted vs realized HR).
- Drop it into the existing seam `calibratePregameHrProbability` (no caller changes).
- Validate with reliability curves, Brier score, log loss, expected calibration error.
- **Precondition:** Phase A.

## Future Phase C — Coefficient fitting
**Goal:** replace the documented default priors with fitted coefficients.
- Fit the additive log-odds term weights / caps via regularized logistic regression
  (or gradient boosting as a challenger) on historical features → HR outcome.
- Keep the additive, capped, no-op-when-absent structure for interpretability.
- Re-validate all invariants + calibration.
- **Precondition:** Phases A–B.

## Future Phase D — Driver calibration & ablation
- Per-driver lift / false-positive / sample-size table → keep / reduce / remove.
- Ablation variants (remove batter power / pitcher / pitch-type / park / lineup;
  v2 with/without bat-tracking, pitch-type, zone, park/spray, shrinkage, suppressors,
  market, confidence gating) scored on top-N lift, monotonicity, Brier, log loss.
- **Precondition:** Phase A.

## Future Phase E — Missing data producers (no backtest needed; parallelizable)
Wire the high-value gaps from `pregame-power-missing-data.md`:
1. Pitcher barrel / hard-hit / FB allowed producer (P1).
2. HR prop odds source → enable `scoreMarketConfirmation` (P1).
3. Rolling 7/15/30 power-trend mapping with heavy shrinkage (P1).
4. Zone/location splits → enable `scoreZoneLocationInteraction` (P2).
5. Bullpen vulnerability aggregation (P2).
The v2 components already accept these inputs (no-op until fed), so producers can be
added without touching the math core.

## Future Phase F — Monte Carlo (design only, not in scope here)
A seeded simulation sampling from the calibrated per-PA HR rate, PA count,
starter/bullpen exposure, pitch-type exposure, and weather/park carry uncertainty —
to produce HR-probability distributions and confidence intervals. Must sample from a
**calibrated** rate (Phase B) and meet promotion criteria before any production use.

## Promotion gate (unchanged from task — do NOT promote v2 to production until ALL hold)
- top-5 slate HR rate improves ≥ 15%
- Elite-tier lift improves ≥ 10%
- Elite > Strong > Watch monotonicity holds
- candidate count does not explode
- calibration error does not worsen
- no leakage detected
- no HR Radar / live files touched
- no live-only fields used

All of the above require Future Phase A (real backtest) at minimum.
