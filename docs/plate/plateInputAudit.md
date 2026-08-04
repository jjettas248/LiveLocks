# The Plate — Pregame HR Engine Input Audit (PR0)

> Baseline commit (frozen reference for every "confirmed from code" claim below):
> **`8c818ec092ad803f57652be4521ae34f26321ae0`** — branch `claude/plate-hr-engine-upgrades-ispzmm`.
>
> This document is the row-level input audit required before the Plate HR engine
> upgrades. It is descriptive only; no engine behavior is changed by this file.

## Two-track architecture (context)

- **Production (champion "July-20"):** a descriptive 0–10 six-component composite
  (`scoring.ts::composePregameScore`) → `classifyTier` → `decidePlatePublication`.
  It is **not** a probability and **ignores exact pitch-type matchup**
  (`matchup.batterXslgVsDominantFamily` is hardcoded `null`,
  `buildPregamePowerRadar.ts:1061`).
- **Shadow (inert):** `math/*` (additive log-odds HR/PA → game prob via a PA
  distribution → identity-uncalibrated) and `hrProbabilityV2/*` (forward-capture +
  offline fit + Platt/isotonic calibrator + model registry), flag-gated, with **zero
  publication authority**. Coefficients there are documented **default priors, not
  fitted** — never surfaced as a probability.

## Row-level input audit

Effect = whether the metric currently moves Probability(shadow) / Grade(`score10`) /
Tag / Display. All Savant metrics derive from the already-fetched season CSV
(`fetchBaseballSavantData`, 4h cache) — no per-card network calls.

| Metric | Source field (type) | Denominator (grain) | Current consumer | Effect | Shrinkage | Missing/stale | Dup risk | Coverage / licensing |
|---|---|---|---|---|---|---|---|---|
| xSLG | `estimated_slg_using_speedangle` (num) | BBE (per contact) | `batterPowerProfile` w2; shadow `scoreBatterTruePower` | Grade + shadow-prob | champ none / chal PA / shadow 120PA | null→neutral, 4h TTL | high (xSLG/xISO/xwOBAcon) | full season; **licensing TBD** |
| ISO / xISO | `xSLG − xBA` (derived, null-guarded `dataSources.ts:728`) | PA/BBE (terminal PA) | `batterPowerProfile` w3 (top); **`power_iso` tag** | Grade + **Tag** | none (champ) | both parts null→null | high | full; lic TBD |
| Barrels/BBE | proxy `EV≥98 & LA 20–35` (num) | BBE (per contact) | `batterPowerProfile` w3; shadow | Grade + Tag(`power_barrel`) | none | null→neutral | high (barrel/HH/EV) | proxy today; **true barrel field = go/no-go** |
| Barrels/PA | not computed | PA (terminal PA) | — | none | — | — | — | derivable if barrel licensed |
| Avg EV | `launch_speed` mean (num) | BBE (per contact) | `batterPowerProfile` w1; shadow | Grade + shadow-prob | none | null→neutral | high | full; lic TBD |
| EV90 (P90 EV) | percentile of `launch_speed` — not computed | BBE (per contact) | — | none | — | — | med (vs avg EV) | derivable from raw rows |
| Hard-hit% | `EV≥95` share (num) | BBE (per contact) | `batterPowerProfile` w2 | Grade | none | null→neutral | high | full |
| Air-ball%/FB% | `bb_type`/`launch_angle` (num) | BBE (per contact) | `batterPowerProfile` w1 (FB%) | Grade | none | null→neutral | med | full |
| Sweet-spot% | `launch_angle ∈ 8–32` share (num) | BBE (per contact) | `batterPowerProfile` w1 | Grade | none | null→neutral | med | full |
| xHR/contact | not computed (EV/LA model) | BBE (per contact) | — | none | — | — | high (vs barrel) | derivable; **not** from `contact_events` (no `xba`) |
| Pulled-air contact% | overall `pullRatePercent` only (proxy, `dataSources.ts:688`) | BBE (≥20) (per contact) | shadow `parkWeatherSpray.batterPullAirShare` (proxy) | shadow-prob | min-sample gate | null→neutral | med | pull% full; pulled-**air** not isolated |
| Whiff% (by family) | `description` swings/misses (num) | swings (≥10) (per swing) | `batterPitchSplits.whiffPct` (**stored, unused by score**) | Display | ≥10-swing gate | null→omit | low (distinct from damage) | full |
| Pitch count (per type) | row counts by `pitch_type` (int) | — (per pitch) | `pitchMixPct` (3-family) | Display/shadow | — | family bucket | n/a | full |
| BBE count | batted-ball rows (int) | — (exposure) | `battedBallEvents` (shrink denom, challenger) | Grade(shrink) | IS the denominator | null→no shrink | n/a | full |
| PA count | `min_pa` grouping (int) | — (exposure) | `paSample` (shadow shrink) | shadow-prob | IS the denominator | null→weight 0 | n/a | full |
| Bat speed | `bat_speed` (num) | competitive swings | shadow `scoreBatTrackingPower` | shadow-prob | 40-swing K | null→no-op | med (vs power) | **2023+ only; coverage/licensing = go/no-go** |

### Exact-pitch sufficient statistics (target contract for later PRs)

The production 3-family `pitchMixPct{fastball,breaking,offspeed}` (`dataSources.ts:793-804`)
collapses and **discards** per-code counts, and `batterPitchSplits` carries **no sample
denominator** (`pitchFamilyMatchup.ts:34-37`). Later PRs persist, per exact pitch code ×
entity(batter/pitcher) × opponent-hand, explicit **grain-typed** sufficient statistics
(no summed ISO). Damage-on-contact divides by **`qualityBbeCount`** (BBE with measurable
EV/LA), never `contactCount` (which includes fouls):

```
pitchCount (per pitch) · swingCount (per pitch) · whiffCount (per swing)
contactCount (per swing; incl. foul) · bbeCount (balls in play; exposure)
qualityBbeCount (BBE with measurable EV/LA — damage-on-contact denominator)
paEndedCount (per terminal PA) · barrelCount (per qualityBBE) · hrCount (per terminal PA)
xslgContactSum (per qualityBBE) · xHrQualitySum (per qualityBBE)
[if ISO retained] terminalAtBats/terminalHits/terminalTotalBases (per terminal PA)
```

## Confirmed root gaps (see plan §4)

1. Production score ignores pitch-type (`:1061`); `matchupFit.sFamily` dead.
2. 3-family ingestion; per-code counts discarded; no ISO/barrel by pitch type.
3. Batter pitch splits carry no denominator.
4. Pitcher vulnerability is handedness-only in the production score.
5. No pitch-location data (`plate_x/plate_z` unparsed; `zone` presence unverified).
6. No BBE-count recent-contact windows (only calendar-day + season aggregate).
7. No pregame projected-PA / starter-vs-bullpen split.
8. Probability uncalibrated & unwired (default-prior shadow coefficients).
9. `power_iso` "Elite Isolated Power" cut too low (`sIso≥6.5` ≈ xISO 0.20) + on the raw
   sub-score + amplified by the power-dominated publication funnel.
10. Client-duplicated grade + BvP banding thresholds.
11. Qualification depends on `positiveDriverCount≥2` (`plateDriverUniverse.ts`).
12. Market can influence surfacing order.

## PR0 change (superseded)

PR0 originally shipped a blunt fix: `power_iso` was **unconditionally suppressed from
presentation** for every hitter via a shared key-based predicate
(`shared/plateDisplaySuppression.ts::isDisplaySuppressedDriverKey`), pending a fitted,
selective threshold.

That threshold shipped ahead of the rest of this plan, in a separate PR
("fix(mlb-plate): repair universal 'Elite Isolated Power' tag — canonical true-ISO
classification", merged to `main` before this branch's own selective threshold work
reached it). It replaced PR0's blanket key-based suppression with a canonical,
reliability-gated true-ISO classifier (`isoAssessment.ts`) that stamps a per-instance
`PowerDriver.displayEligible` flag — so the tag now correctly renders for genuine
elite-ISO hitters instead of being hidden for everyone. `champion score10/tier/
positiveDriverCount/qualification/publication` remain byte-identical, same as PR0's
original guarantee.

This branch has been updated to drop PR0's now-superseded blanket-suppression module
and its call sites (`diagnostics.ts::buildResponse`,
`winAttribution.ts::pregameDriverDigest`, `PregamePowerRadar.tsx`) in favor of reading
`displayEligible` directly, so only one Elite-ISO display gate exists in the codebase.
`shared/plateDisplaySuppression.ts` and its two isolation tests no longer exist.
