# The Plate — Isolated Power (ISO) classification & display contract

_Last updated: 2026-08-03. Classifier: `iso_assessment_v1`._

## Why this exists

In production nearly every displayed Plate hitter received the **"Elite Isolated
Power"** tag, making it useless for comparing targets. Root cause was two layers:

1. **On-contact inflation.** `server/mlb/dataSources.ts` computes `xISOSeason =
   xSLG − xBA` from Statcast `estimated_ba/slg_using_speedangle` accumulated over
   **batted balls only** (non-contact PAs skipped). That yields *on-contact*
   xBA/xSLG, so `xISO ≈ .20–.30` — ~50% above true per-AB isolated power
   (league ISO ≈ .14).
2. **Hardcoded label at a low threshold.** `batterPowerProfile.ts` emitted
   `{key:"power_iso", label:"Elite Isolated Power"}` whenever
   `sIso = lin(xISO,0.09,0.26) >= 6.5` (i.e. `xISO >= ~.20`), with no tiering,
   reliability, sample, or handedness-split gating.

## The fix — model use vs. tag display are separate decisions

The on-contact `xISO` still feeds `score10` unchanged (the champion
`plate_jul20_restored_v1` is backtested against it). What changed is **only the
display label + a display gate**, driven by a new canonical assessment.

- **`isoAssessment.ts` (`assessIso`)** — one pure, typed classifier for TRUE
  per-AB ISO. It never feeds the score.
- **ISO formula & units.** Canonical decimal scale (`SLG − AVG`), or from counting
  stats on ONE denominator `(2B + 2·3B + 3·HR) / AB`. Stats from different
  samples/denominators are never combined.
- **Source priority / handedness.** The build resolves the split matching the
  opposing pitcher's hand (`current_split`) from real season split rate stats. No
  usable split → the tag fails closed; a `league_fallback` source can never be
  elite-eligible. An overall/prior source never masquerades as a hand split.
- **Sample denominator.** The sample is **at-bats (AB)** from the matchup
  handedness split (Stats API `stat.atBats`) — never manufactured plate
  appearances. AB is the correct denominator for ISO (SLG and AVG are both
  per-AB) and is also used as the reliability/shrinkage denominator (no distinct
  reliability denominator). Genuine PA exists on the same row but is not used.
- **Shrinkage / reliability.** `weight = sampleAB / (sampleAB +
  ISO_STABILIZATION_AB)`; `adjustedIso = weight·rawIso + (1−weight)·LEAGUE_PRIOR_ISO`.
  `reliability = weight`.
- **Tiers (on the adjusted ISO; absolute thresholds).** ELITE ≥ .240, STRONG ≥
  .200, AVERAGE ≥ .130, else WEAK; invalid/insufficient → UNAVAILABLE. No stable
  same-population percentile source is wired yet, so `percentile` is reported
  `null` (never fabricated).
- **Elite eligibility.** ELITE tier **and** non-fallback source **and** reliability
  ≥ floor **and** sample ≥ elite floor. Only then does the chip read "Elite
  Isolated Power". STRONG (reliable) → "Strong Isolated Power". Otherwise no
  promotional chip (`displayEligible:false`) — the model may still use the input.
- **Fail-closed validation.** Non-finite, out-of-range (a percentage-scale `24` /
  `240`), negative, or unsampled ISO can never become elite; a `0` ISO is a valid
  WEAK, never a crash or an elite.

All thresholds/priors/floors and the classifier version live in one place:
`isoAssessmentConfig.ts` (`ISO_ASSESSMENT_VERSION = "iso_assessment_v1"`).

## Champion safety (why this is a display-only change)

`power_iso` is in `JUL20_POSITIVE_DRIVER_KEYS` and counts toward
`positiveDriverCount`, which feeds champion **suppression** (`scoring.ts`) and
**publication** (`platePublicationDecision.ts`). The driver's **key, direction,
and emission condition (`sIso >= 6.5`) are unchanged**, so `positiveDriverCount`,
`score10`, suppression, and publication are byte-for-byte identical. Only `label`,
`displayEligible`, and `tier` (additive `PowerDriver` fields) changed. Proven by
the unchanged, green champion suites (`plateChampionJul20Regression`,
`plateModelShadowIsolation`, `plateModelComparisonStats`).

## Display selection

The client (`PregamePowerRadar.tsx`) renders server-stamped drivers verbatim and
now also excludes `displayEligible === false` chips (compact + expanded). It never
recomputes ISO, score, or tier.

## Distribution guardrail (read-only)

`isoDistributionAudit.ts` aggregates per-slate ISO tier distribution + displayed-
tag prevalence and logs `[PLATE_ISO_DISTRIBUTION]`, warning when ELITE exceeds 25%
of eligible hitters, or any selective tag exceeds 50% of displayed cards on two
consecutive slates. It never mutates a signal, blocks the response, or auto-retunes
a threshold.

## Rollback

Behavior is versioned by `ISO_ASSESSMENT_VERSION`. To revert the display change,
restore the single `power_iso` push in `batterPowerProfile.ts` to the prior
unconditional `"Elite Isolated Power"` label — the score path was never touched, so
no score/goldmaster rebaseline is involved.

## Pre-deployment population gate (real-data validation)

Synthetic fixtures cannot prove selectivity on the real hitter distribution.
`scripts/plateIsoPopulationAudit.ts` is a read-only gate that runs the canonical
`assessIso` classifier over a **real** hitter export and fails (non-zero exit)
when Elite prevalence exceeds the cap:

```
npx tsx scripts/plateIsoPopulationAudit.ts <export.json> [--max-elite-pct 25] [--json]
```

The export is a JSON array of `{ ab, slg, avg | iso, split?, source? }` rows (AB is
the ISO denominator). Wire this into CI or run it in an authorized environment
with a real Stats API / DB export before deploying an ISO-classifier change. It
imports only the pure classifier — no engine, bus, or storage access.

**Status: real-population validation remains UNEXECUTED in the build sandbox** —
the live Stats API is blocked by the proxy and no `DATABASE_URL` is configured, so
only an MLB-calibrated deterministic population (matching the 2024 qualified-hitter
ISO percentile curve) has been run here. It must be executed against a real export
as a pre-deployment gate.

## Tests

- `server/mlb/pregamePowerRadar/isoAssessment.test.ts`
- `server/mlb/pregamePowerRadar/isoTagSelection.test.ts`
- `server/mlb/pregamePowerRadar/plateChampionSlateInvariance.test.ts`
