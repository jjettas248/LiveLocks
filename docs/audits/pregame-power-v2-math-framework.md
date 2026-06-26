# Pre-Game Power Radar — v2 Math Framework (Shadow)

How the v2 **shadow** math core turns pre-first-pitch features into a calibrated-
shaped HR probability and a ranked, tiered candidate. Implemented under
`server/mlb/pregamePowerRadar/math/**` — pure, additive, **not wired into
production**. Production scoring (`scoring.ts`) is unchanged.

> **Status of the numbers:** every coefficient, cap, and reference midpoint below
> is a **documented DEFAULT PRIOR** (literature-informed approximate MLB average),
> **not** a parameter fitted to historical outcomes. The model is intentionally
> *uncalibrated* — empirical calibration is a deferred future phase. See
> `pregame-power-v2-future-phases.md`.

---

## 1. Pipeline

```
PregameMathInputs (pre-first-pitch only, typed; no live fields)
  → component scorers  → additive log-odds terms (each capped, no-op when absent, shrunk)
  → buildPregameHrPerPa → cumulative logit → sigmoid → clamp[MIN,MAX] → prior shrinkage
  → estimatePregamePaDistribution → P(PA=n) over {2..6}, Σ=1
  → gameHrProbability → Σ P(PA=n)·(1−(1−hrPerPa)^n)
  → calibratePregameHrProbability → IDENTITY passthrough (deferred)
  → rankPregameCandidate → 4 scores + shadow tier
  → runPregameMathModel → PregameMathModelResult (drivers, suppressors, coverage, diagnostics)
```

## 2. Per-PA HR probability model

A transparent additive **log-odds** model:

```
logit(hrPerPa) = intercept
  + batterPowerTerm + batTrackingTerm
  + pitcherVulnerabilityTerm
  + pitchTypeInteractionTerm + zoneLocationInteractionTerm
  + parkWeatherSprayTerm
  + lineupOpportunityTerm + starterBullpenPathTerm
  + marketConfirmationTerm
  − suppressorPenaltyTerm

hrPerPa = clamp(sigmoid(logit), 0.001, 0.12)
```

- **Intercept** = `logit(LEAGUE_HR_PER_PA)`, `LEAGUE_HR_PER_PA = 0.0335`.
- Each term is a **centered, capped** log-odds delta: `cap × signedFeature × shrinkWeight`,
  where `signedFeature ∈ [-1,1]` is the stat relative to a league-average midpoint,
  and `shrinkWeight = n/(n+k) ∈ [0,1)` from the backing sample.
- **Absent feature → term 0** (true no-op; never destabilizes a partial row).

### Term caps (max |log-odds|)
| Term | Cap | Note |
| --- | --- | --- |
| batterPower | 0.85 | dominant driver |
| pitcherVulnerability | 0.55 | HR/9 vs hand + batted-ball allowed; **ERA excluded** |
| parkWeatherSpray | 0.45 | park (by-hand) + wind (pull-gated) + temp |
| pitchType | 0.35 | usage-weighted batter damage by family |
| zoneLocation | 0.30 | hot-zone × mistake-zone overlap |
| batTracking | 0.30 | secondary power (bat speed/squared-up/blast) |
| marketConfirmation | 0.25 | confirm/rank only; never creates a candidate |
| starterBullpenPath | 0.20 | secondary; × bullpen-exposure share |
| lineupOpportunity | 0.10 | small (volume handled by PA distribution) |
| suppressorPenalty | −0.80 max | subtractive only |

Caps + the final clamp guarantee **no single feature** can push the per-PA rate
past the Phase-1.5-style ceiling (max 0.12 HR/PA).

### Prior shrinkage (stability, NOT calibration)
After assembly, the per-PA estimate is blended toward `LEAGUE_HR_PER_PA` by an
effective sample = `batterPaSample × coreCoverage` with `k = 170`. Low coverage /
thin samples → output near league average. This is **prior shrinkage for runtime
stability**, distinct from fitting to realized HR outcomes.

## 3. PA distribution & game probability

`estimatePregamePaDistribution(slot, teamImpliedRuns)`:
- Expected PA per slot (documented prior): leadoff ≈ 4.65 → #9 ≈ 3.85.
- Implied-run nudge ±0.25 PA.
- Discrete Gaussian kernel over bins {2,3,4,5,6}, **normalized to sum 1**.

`gameHrProbability(hrPerPa, dist) = Σ_n P(PA=n)·(1−(1−hrPerPa)^n)` — monotonic in
both `hrPerPa` and PA count, always bounded `[0,1]`.

## 4. Calibration (DEFERRED — identity passthrough)

`calibratePregameHrProbability` is an **intentional identity** that only enforces
`[0,1]` bounds and reports `method: "identity_uncalibrated"`. It is the stable seam
where a fitted calibrator (isotonic / Platt) drops in later **without changing any
caller**. Until a historical backtest exists, no rescaling is applied and no
consumer may treat the output as a calibrated probability.

## 5. The four orthogonal scores + tier

| Output | Meaning | How |
| --- | --- | --- |
| `rawSetupScore100` | quality of HR setup (volume-free skill lift) | net log-odds lift above baseline → [0,100] |
| `probabilityScore100` | modelled game HR chance | game HR prob over [0,0.30] → [0,100] |
| `confidenceScore100` | trust in data/model | 0.6·coverage + 0.4·sample, × suppressor factor |
| `candidateRankScore100` | board sort key | 0.35·prob + 0.25·lift + 0.20·setup + 0.10·confidence (lift/historical weights redistributed when absent) |

**Shadow tier** (`recommendedTier`, diagnostics-only — never replaces production
tiers): Elite (prob ≥ 0.10 & confidence ≥ 70 & no major suppressor) ·
Strong (prob ≥ 0.075 & confidence ≥ 60) · Watch (good setup) · Suppressed (major
suppressor or prob < 0.04) · Neutral otherwise. Slate-percentile gates (top 1–5% /
5–12%) are a **board-level** concern applied across a slate by the ranking caller.

> The task's `candidateRankScore` includes a `historicalDriverLiftScore` (0.10).
> That term needs a historical backtest and is **deferred**; its weight is
> redistributed proportionally across the present terms and the omission is recorded.

## 6. Lifts vs baselines
- `playerBaselineGameHrProbability` — from the player's shrunk season HR/PA over the same PA distribution.
- `slateBaselineGameHrProbability` — slate prior passed in (no leakage).
- `marketImpliedHrProbability` — from odds when available (else null).
- `hrLiftVs{Player,Slate,Market} = calibratedGameHrProb / baseline` (null when baseline absent).

## 7. Output contract
`PregameMathModelResult` (`mathTypes.ts`): all per-PA stage snapshots, PA
distribution, raw + (identity-)calibrated game HR probability, three baselines and
lifts, the four scores, shadow tier, `drivers[]`/`suppressors[]`, `statCoverage`,
and `shrinkage/interaction/calibration` diagnostics + `missingData`/`leakage`
warnings.

## 8. Guarantees / invariants (unit-tested)
- Per-PA HR clamped to `[0.001, 0.12]`; game probability bounded `[0,1]`.
- PA distribution sums to 1 for every slot.
- Game HR probability strictly increases with PA count and with per-PA rate.
- Every component is a no-op when its data is absent; small samples shrink toward priors.
- Pitch-type interaction weights damage by pitcher usage and shrinks sparse splits.
- Park/spray rewards matching handedness/spray/wind fit; suppresses poor fit.
- Confidence falls with missing lineup/weather/sample data.
- Elite-setup inputs out-rank weak-setup inputs; a confirmed scratch forces `suppressed`.
- No leakage warnings on a clean pregame row; live-only feature names are rejected.

**Test files:** `math/{leakageGuard, shrinkAndNormalize, paAndGameProbability,
components, modelAndRank}.test.ts` — 160 assertions, all passing.

## 9. Why this is stronger than the current weighted score (design rationale)
1. **Probability, not a score** — outputs a per-PA and game HR probability the
   ranking/tiers derive from, instead of an opaque 0–10 composite.
2. **Volume-aware** — PA distribution converts per-PA skill into per-game HR chance,
   so batting-order opportunity is modeled explicitly.
3. **Uses dormant signal** — handedness park factor, bat-tracking, pitch-type usage
   weighting, and pull-gated wind all reach the estimate.
4. **Honest uncertainty** — shrinkage + confidence + coverage make thin-data names
   regress to league, reducing weak surfaced names.
5. **Separable concerns** — setup quality, probability, confidence, and rank are
   distinct outputs, so tiering can be tuned without conflating them.

These are *design* improvements; **they are not yet validated against outcomes**.
Promotion to production requires the deferred backtest proof.
