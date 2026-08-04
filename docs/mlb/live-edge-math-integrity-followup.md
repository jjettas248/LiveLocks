# MLB Live Edge — mathematical-integrity follow-up (deferred)

_Prepared 2026-08-03 alongside the Plate ISO repair. **This is a report, not a
change** — no engine code in this list was edited on the
`claude/plate-elite-power-tag-fix-ba4u64` branch. Each item touches the just-
recovered Live Edge market engine + the goldmaster drift guard + ~40 regression
suites, so it is scoped as separate, dependency-ordered work per the branch owner's
decision._

Every item below was traced to the **active** production path (not dead/frozen
code). File:line references are from the current branch. Fixes must follow §7a of
`CLAUDE.md`: change math in the engine layer, keep new inputs additive/no-op when
absent, cap effects, **re-baseline the goldmaster** (`MLB_GOLDMASTER_VERSION`), and
run the regression suites, adding cases for the new behavior.

## Confirmed ABSENT / neutralized (no action)

- **Odds provenance** (§8.3). `markets.ts` `buildOutput`/`calculateHitsEdge`
  preserve `oddsUpdatedAt`/`oddsFetchedAt`/`sportsbook` from the source; only
  engine-generation timestamps use `Date.now()`. `mlbOddsProvenanceContract.test.ts`
  already enforces this. No fix needed.
- **Self-learning denominators** (§8.9). `markets.ts` `getSelfLearningShrink`
  returns a constant `0.96` (`reason=no_production_path`); `hrConversionModel.ts`
  `calibrate` uses the static table and only shadow-logs the empirical buckets. The
  denominator-mismatch defect exists only in disabled shadow code. No production
  fix needed (but do not enable the shadow path without fixing its denominators
  first).

## Confirmed ACTIVE defects — prioritized

### P1 — Suppression can coexist with an actionable recommendation (§8.1)
`server/mlb/markets.ts` — `checkSuppression` early-returns `suppressed:false` for
batter-over markets (403–405); call sites then emit `suppressed: suppression.suppressed`
while keeping `recommendedSide: OVER` and a non-zero edge
(`buildOutput` 797–802/887; `calculateHitsEdge` 968–974/1028; `calculateTBEdge`
1111–1117; `calculateHREdge` 1502–1508 — each hardcodes `*IsBatterOver = true`).
**Failure:** a hits/TB/HR signal surfaces `suppressed:true` yet actionable.
**Fix direction:** separate hard data-integrity/eligibility gates (missing contact
data, invalid gap/probability, stale/missing required odds) from the optional
edge-floor. Integrity failures must force `NO_EDGE` + non-actionable regardless of
market; disable only the edge-floor rule for batter overs, explicitly. Make the
suppressed flag and the recommendation impossible to contradict by construction.

### P2 — Batting average used as a home-run rate (§8.2)
`server/mlb/projections.ts` `computeBaseValue` (37–101) reuses one `seasonAvg` as
the rate for every market; `home_runs` (70–76): `const hrRate = seasonAvg > 0 ?
seasonAvg : 0.035;` — a ~.250 batting average used as HR-per-AB.
**Fix direction:** replace the generic rate with market-specific typed inputs
(`hitRatePerAB`, `totalBasesPerAB`, `hrRatePerPA`, `strikeoutRatePerPA`,
`hrrRatePerPA`), each with the correct denominator; hydrate HR probability from the
real `seasonHRRate` (per PA) already computed in `dataPullService.ts` with a
documented fallback + reliability; add compile-time pressure so a batting average
cannot be passed into an HR-rate function. (The `<0.15` locus in
`eventRates.ts:174-176` / `hrEngineVersions/liveEdgeHrV1.ts` is **dead/frozen** —
`home_runs` now sources `computeHRConversionProbability` — so fix the live
`projections.ts` locus, not the frozen one.)

### P3 — playerId hashed into feature values (§8.4)
`server/mlb/featureEngineering.ts` `computeFullFeatureLayer` (1352–1366): a
deterministic hash of `playerId` becomes `microNoise = ±0.02`, added to
contactQuality/batSpeedPower/handednessMatchup/pitchBlendMatchup/hotColdForm/bvp.
**Fix direction:** remove the noise entirely; identical baseball inputs must yield
identical outputs. If deterministic UI tie-breaking is ever needed, apply it after
scoring and never to the score/tier.

### P4 — Calibrated over/under need not sum to 1 (§8.5)
`server/mlb/markets.ts` `calibrateDistributionProb` (338–347) shrinks + clamps
`[5,96]` + applies a per-market ceiling **independently** to each side
(`calculateHitsEdge` 953–954; `calculateTBEdge` 1096–1097). (HR already derives the
complement at 1480.)
**Fix direction:** compute one side from the distribution and derive the complement
exactly; apply any safety ceiling to one side and recompute the other from it;
store probabilities in a single unit internally.

### P5 — Estimators force ≥1 remaining trial (§8.6)
`server/mlb/math/distributions.ts` `binomialOverProbability` (40):
`const n = Math.round(Math.max(1, remainingPA));` — non-zero over-probability even
with `remainingPA = 0`. `probabilityEngine.ts` also defaults `remainingPA ?? 2`.
**Fix direction:** support `remainingPA/remainingBF = 0` (probability 0 for a
needed event; 1 if the target is already achieved); keep "unknown opportunity"
distinct from "known zero" — never silently coerce null to 0 or 1.

### P6 — "HR overdue" gambler's-fallacy scoring (§8.7)
Positive HR score the longer since the last HR, in three active loci:
`evaluateHRAlert.ts` 606–611; `HRSignalBuilder.ts` 503–509; `signalScore.ts`
`computeHrTimingScore` 638–650.
**Fix direction:** remove elapsed-AB-since-last-HR as a positive probability/
readiness factor from all scoring/tiering/qualification/tags. Recent contact
quality may matter; "being due" must not. May remain as clearly-labeled descriptive
context only.

### P7 — Bullpen modifier inverted (§8.8)
`server/mlb/eventRates.ts` `computeHitRate` (50–53): `bullpenFactor =
clamp(4.15 / bullpenEra, 0.94, 1.06)` — a strong (low-ERA) bullpen **raises** the
batter's projected hit rate.
**Fix direction:** invert the relationship (worse/higher ERA must not lower the
hitter's event rate; better/lower ERA must not raise it), centralize and cap it.
Note `featureEngineering.ts` `computeSpecBullpenFactor` already uses the correct
direction — the engine is internally inconsistent today.

### P8 — Estimated features labeled as measured (§8.10)
`server/mlb/featureEngineering.ts` `computeBatSpeedEngine` (925–926) falls back to
an EV-derived bat-speed estimate but still drives "High/Elite/Explosive Bat Speed"
badges (1516–1519) with no measured-vs-estimated flag; ERA is used as an
HR-susceptibility proxy (`hrConversionModel.ts`), hard-hit rate as a chase/whiff
proxy.
**Fix direction:** declare source/unit/sample/measured-vs-proxy/reliability per
feature; rename misleading proxy labels; prevent proxies/fallbacks from producing
"Elite" claims. Do not remove a useful conservative input solely because its label
is wrong; do not add new vendors.

## Suggested commit order for the follow-up branch

P3 (pure removal, low risk) → P7 (single-formula direction) → P6 (remove overdue) →
P5 (zero-opportunity) → P4 (complement coherence) → P2 (rate units) → P8 (proxy
provenance) → P1 (suppression/actionability — largest, do last with the most test
coverage). Re-baseline the goldmaster once per behavior change and run the full MLB
regression suite between commits.
