# Pre-Game Power Radar — Missing-Data Report

Focused companion to `pregame-power-stat-coverage.md`. Lists the data the v2
model **wants but does not yet have**, why it matters, where it could come from,
and how the v2 math core behaves in its absence (it degrades safely — every
missing input is a no-op, never a fabricated value).

## How v2 handles missing data (by design)
- Every component scorer returns `available: false, logOdds: 0` when its inputs
  are absent → **no contribution**, not a guess.
- Sparse samples are shrunk toward league priors (`shrinkRates.ts`).
- Missing core families (batter power, pitcher profile) pull the per-PA estimate
  back toward the league baseline and **lower `confidenceScore100`**.
- `statCoverage` records each family as `used | missing | fallback | not_available`,
  and `missingDataWarnings[]` lists the specific gaps.
- `not_available` (e.g. market odds, zone splits) is distinguished from `missing`
  (data exists for this game but was not fetched) so the gap is honestly labelled.

## Missing data, by impact

| Data | Priority | Why it matters for HR | Candidate source | v2 behavior when absent |
| --- | --- | --- | --- | --- |
| Pitcher **barrel / hard-hit / FB allowed** | P1 | Direct HR-contact-quality allowed; HR/9 alone is noisy | Savant pitcher Statcast (producer not wired) | optional inputs already accepted; term uses HR/9 only |
| **HR prop odds** (implied / no-vig) | P1 | Market confirmation / ranking; sharp signal | New sportsbook/odds feed (none today) | `scoreMarketConfirmation` no-op; `marketConfirmation: not_available` |
| **Rolling 7/15/30 power trends** (xSLG/barrel/pull-air) | P1 | Hot/cold form before first pitch | Exists in `dataPullService` (rolling OPS/SLG/HR-rate) — needs mapping + shrink | season rates only |
| Pitcher **recent-start** barrel/hardHit/HR allowed | P1 | Pitcher form/fatigue trend | recent-starts feed exists (ERA/pitch count) — extend | season splits only |
| Batter/pitcher **zone & mistake-zone** splits | P2 | Hot-zone × mistake-zone overlap is a strong HR driver | New Statcast zone aggregation | `scoreZoneLocationInteraction` no-op (`not_available`) |
| **Bullpen** HR/9, barrel allowed, hand mix, fatigue | P2 | Late-PA HR path | New bullpen aggregation | `scoreStarterBullpenPath` no-op (secondary, capped) |
| **Times-through-order** HR/barrel profile | P2 | 2nd/3rd-time-through HR spike | Savant TTO splits (new) | starter exposure uses default prior |
| Wind **vector by field sector** / pull-side boost | P2 | Carry direction vs batter spray | `windDegrees` + stadium coords exist — derive sector | wind treated as in/out/cross only; pull-gated |
| Air **density / humidity / pressure** carry | P2 | Fine-grained carry | humidity/pressure present — derive density | temperature only |
| **Injury / late-scratch / rest** news | P1 | Availability = opportunity; bad surface risk | New news/lineup-confirmation feed | `scoreAvailabilitySuppressors` no-op unless flags provided |
| Park factor by **batted-ball type / spray sector**, wall height | P3 | Park fit refinement | New park geometry dataset | handedness park factor only |
| **Similarity / archetype** features | P3 | Replace tiny BvP samples | Derived clustering (new) | BvP kept tiny/shrunk diagnostic only |
| Umpire / catcher framing context | P3 | Marginal zone/walk effects | New assignment + framing feed | not modeled |

## Already-available-but-unused (quick wins — no new source)
1. **Park HR factor by handedness** — already loaded; v2 consumes `parkHrFactorHand`.
2. **Bat-tracking** (bat speed, swing length) — pulled by Savant, unused by production; v2 `scoreBatTrackingPower` consumes it.
3. **Batter pitch-type whiff splits** — present; usable as a pitch-type suppressor.
4. **Pitcher pitch-mix %** — present; drives `scorePitchTypeInteraction` usage weighting.
5. **Rolling form** — present in `dataPullService`; needs a mapping pass + heavy shrinkage.

## What CANNOT be sourced pregame (must stay excluded)
Current-game EV / launch angle / barrel / hard-hit count, current pitch count /
count / base-out / inning, live pitcher deterioration / command decay, live wind
shifts, current-game spray / Statcast events. These are enforced as forbidden by
the leakage contract (`leakageGuard.ts`) and are absent from `PregameMathInputs`
by construction.

## The single biggest gap
**Calibration data.** The v2 model produces a *modelled* HR probability from
documented priors, but there is **no historical-outcome backtest** in this
environment (no `DATABASE_URL`, no archive). Turning the modelled probability into
a *calibrated* one — and proving Elite > Strong > Watch monotonicity and top-N
lift — requires a historical join that is an explicitly **deferred future phase**
(see `pregame-power-v2-future-phases.md`).
