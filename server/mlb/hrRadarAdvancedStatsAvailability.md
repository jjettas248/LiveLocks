# HR Radar Advanced Stats Availability Map

> Scope: **HR Radar Live v2 shadow model only.** "Available" here means a field
> the admin endpoint can reach through `buildHrRadarV2InputFromCanonicalState`
> **without** importing the live orchestrator, calling hot-path services, or
> adding DB joins. A field existing *somewhere* in the repo is **not** enough —
> if the v2 input adapter can't reach it from `CanonicalHrRadarState`, it is
> **not scored** (returns `null`, recorded in the inventory).

The v2 model is computed on-demand and returned read-only by
`GET /api/admin/mlb-hr-radar-v2-shadow`. It changes **no** production scoring,
stage, alert, grading, or user-visible behavior.

---

## Available to admin endpoint now
Present on `CanonicalHrRadarState` or directly mapped by the adapter:

- `lifecycleState`, `section`, `userStage` (production stage — read-only context)
- `displayScore10`, `peakScore10` (production scores — read-only context)
- `detectedAt`, `latestEvidenceAt` (ISO timestamps)
- `detectedInning`, `latestEvidenceInning`
- `triggerReasons[]`, `triggerTags[]` (engine-built driver labels / matched paths)
- `contactEvidence[]` — the richest live evidence; each record carries the
  real batted-ball fields the orchestrator stamps:
  `abIndex`, `ev` (exit velocity), `la` (launch angle), `distance`, `xba`,
  `isBarrel`, `outcome`.

## Derivable from canonical state now
Direct derivations from the real fields above (no proxies, no inference):

- **EV trend** / **LA trend** — from the real EV/LA values across the
  `contactEvidence` window (`scoreLiveSwingTrend`).
- **Contact geometry** — strongest real batted ball blended from EV/LA/
  distance/barrel (`scoreContactGeometry`).
- **Near-HR tier + repeated-danger** — reusing the engine's
  `detectNearHrContactPeak` over the reconstructed contact window.
- **Repeated hard-hit count** — counting real qualifying batted balls.
- **Freshness / staleness** — from real `latestEvidenceAt` vs injected
  `referenceTimeIso` (time-based) or inning gap (`scoreFreshnessDecay`). No
  wall-clock `new Date()` is used inside scoring.
- **Data quality / completeness** — fraction of real batted-ball fields
  populated (`scoreDataQuality`).

## Available elsewhere in codebase but not endpoint-accessible
Present in `types.ts` / `dataPullService.ts` / services, but **not** on
`CanonicalHrRadarState`, so **not scored** (the relevant scorers return
`null` today; wiring them would require hot-path imports or DB joins, which
this shadow PR explicitly avoids):

- Pitcher state: pitch count, times-through-order, velocity drop, collapse/
  leash flags, ERA/WHIP/K9/BB9 → `scorePitcherDeterioration` returns `null`.
- Full pitch mix + per-type velocity.
- Park / weather context: park factor, temperature, wind speed/direction,
  humidity, roof/indoors → `liveEnvironmentFit` is `null`.
- Game state: outs, runners-on-base, score differential →
  `scoreGameStateAttack` returns `null`.
- Handedness splits, rolling form, HR-trend windows (also historical — see
  below).

## Historical / diagnostics-only
Recorded for context, **never** scored as live evidence (and not
endpoint-accessible regardless):

- Season pull%
- Batter-vs-pitcher (BvP) history
- HR-trend windows (last 7 / 15 / 30)
- Rolling batting form
- Batter/pitcher handedness splits
- Generic season pitcher stats (ERA / WHIP / K9 / BB9)

## Missing / future-feed required
No endpoint-accessible source today → corresponding scorers return `null`
(no proxies permitted). These are the highest-value future upgrades:

- Ball/strike count → `scoreCountLeverage`
- Batter pitch-type damage splits → `scorePitchTypeDamage`
- Pitcher pitch-type HR/barrel vulnerability → `scorePitcherPitchTypeVulnerability`
- Pitch-location / zone-mistake / meatball / hanger data → `scoreZoneMistakeRisk`
- Pull-side air / spray profile + raw spray angle → `scorePullAirIntent`
- Park-sector geometry (wall distances by sector) → `scoreParkGeometryFit`
- Wind vector by spray direction → `scoreWindSprayFit`
- Pitcher command-by-zone deterioration → `scoreCommandDeterioration`
- Swing-decision today (chase / whiff / zone-contact) → `scoreSwingDecisionForm`
- Batter-vs-similar-pitcher archetype → `scoreSimilarityMatchup`
- Umpire zone / catcher framing → `scoreUmpCatcherContext`
- Fatigue / rest / travel → `scoreBatterFatigue`
- Live HR-prop odds movement → `scoreMarketConfirmation`
- Driver-level calibration buckets (replay/backtest) → `scoreDriverCalibration`

---

## Used in v2 shadow scoring today
Only genuinely real / directly-derivable signals influence the score:

| Layer | Signal | Source |
| --- | --- | --- |
| Core | live contact geometry | real EV/LA/distance/barrel |
| Core | near-HR signal | `detectNearHrContactPeak` |
| Core | live swing trend | real EV trend |
| Suppressor | stale evidence | real timestamps/innings |
| Suppressor | weak contact | real geometry |
| Suppressor | incomplete data | real field completeness |
| Confidence | evidence volume / freshness / completeness / agreement | real evidence |

Everything else (pitcher deterioration, environment, opportunity, count
leverage, and all 12 advanced-context components) is `null` today and
contributes **0**. The advanced-context boost is therefore **0** until the
future feeds land — by design, no hidden optimism.

## Diagnostics-only (recorded, not scored)
The historical/season block above, plus the per-component null map and raw
boost-before-clamp values surfaced under `diagnostics` in the shadow output.

## Do not use
Anything pregame-only, season-only, or simulated as a *row-creating* signal:
Pre-Game Power, Power Prior, Monte Carlo, pregame seeding/ranking, projected
HR probability, market steam. These may calibrate live evidence in a future
PR but must never create a Track/Build/Ready/Fire row by themselves.
