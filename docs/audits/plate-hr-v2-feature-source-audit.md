# Plate HR Probability V2 — Feature-Source Audit (PR 1)

Read-only audit produced ahead of any model code, per the mission spec's own
requirement to trace the current repository and produce a feature-source
matrix before implementation. Companion docs (this doc supersedes ad-hoc
re-derivation of the same ground, cross-referencing rather than duplicating):
`pregame-power-v2-inspection.md`, `pregame-power-v2-future-phases.md`,
`pregame-power-missing-data.md`, `pregame-power-stat-coverage.md`,
`pregame-power-engine-current-state.md`.

## 0. What changed the shape of this project

The mission spec assumed a from-scratch build. This audit found that roughly
half of what it asks for **already exists**, fully tested, at
`server/mlb/pregamePowerRadar/math/` — a ~2,600-line shadow engine (built in
two efforts, 2026-07-03 and 2026-07-24) implementing the hazard-process
HR-probability conversion, a PA-count distribution model, empirical-Bayes
shrinkage, a working walk-forward regularized-logistic fitter with
Brier/log-loss, and 8 tested component scorers — plus three orphaned
real-data adapters (`pitchFamilyMatchup.ts`, `parkDimensions.ts`,
`batTrackingResearch.ts`) that solve exactly the "known gaps" the spec asked
to verify. None of it was ever wired into production; the environment it was
built in had no historical data to validate against, the same constraint
this session has (no `DATABASE_URL`).

**Decision:** the new model's identity, `plate_hr_probability_v2_shadow`,
lives in a new directory `server/mlb/pregamePowerRadar/hrProbabilityV2/`
(matching the spec's own suggested layout) and **imports `math/`'s tested
functions as a library** rather than re-deriving them. `math/` itself is not
moved, renamed, or modified. The champion (`plate_jul20_restored_v1`) and
existing challenger (`plate_current_shadow_v1`) are untouched.

## A. Current-State Architecture

### A.1 — Production champion (frozen, not touched by this work)

`server/mlb/pregamePowerRadar/scoring.ts` composes a 6-component weighted
score (weights sum to 1.00): Batter Power 0.28, Pitcher Vulnerability 0.23,
Matchup Fit 0.18, Park/Weather 0.14, Lineup Opportunity 0.09, Near-HR Recent
Form 0.08.

- **Batter Power** (`batterPowerProfile.ts:56-80`): all 11 stats present as
  described (xISO w3, Barrel% w3, HardHit% w2, xSLG w2, MaxEV w2, HR/FB w2,
  avgEV w1, FB% w1, Pull% w1, SweetSpot% w1, xwOBA w1), renormalized over
  present legs.
- **Pitcher Vulnerability** (`pitcherVulnerability.ts`): HR/9(w4) + ERA(w2)
  vs. batter handedness only. Five challenger-only legs (contact-allowed
  barrel/hard-hit/fly-ball, last-3-start ERA, rest days) exist but are gated
  off for the champion policy.
- **Matchup Fit / `batterXslgVsDominantFamily`**: confirmed always `null` at
  both production call sites (`buildPregamePowerRadar.ts:547,1024`). The
  function that could compute it, `pitchFamilyMatchup.ts:48-64`
  (`batterXslgVsPitcherDominantFamily`), was dead code — zero callers
  anywhere until this PR's forward-capture tap became its first caller
  (via the sibling `buildPitchTypeInteractionInputsFromSavant`, wired only
  into V2's research capture, never into the champion).
- **Lineup Opportunity**: batting-slot only in practice; `teamImpliedRuns`
  and `obpAhead` are also always `null` at every call site
  (`buildPregamePowerRadar.ts:612-613,1045-1046`).
- **Near-HR Recent Form** (`nearHrRecentForm.ts`): retroactive 3-ET-day
  recency-weighted replay of the live near-HR detector; persisted contact
  events don't carry `hitType`/`xba`, so outcome-aware "almost HR" paths are
  structurally unreachable retroactively.
- Total Bases isolation is clean except one narrow crack: `mkt_tb` (weight-0
  on `score10`) counts toward the same `positiveDriverCount` gate that
  unlocks public visibility, alongside `mkt_hr`. Grading remains strictly
  HR-based regardless. V2 inherits none of this — it has no publication
  authority at all.

### A.2 — Existing champion/challenger scaffolding

`modelVersions/` is a mature champion-vs-challenger comparison pattern: a
deep-frozen, SHA256-hashed shared input DTO (`FrozenPlateInput`), a pure
`evaluatePlateModel(frozen, policy, ctx)` dispatcher keyed only by which
policy object is passed, XOR-based delta attribution, and sticky
public-exposure tracking. Hardwired to exactly 2 models today. Extending it
to a 3-way (champion/challenger/V2) comparison is future work (PR4) — not
touched here.

### A.3 — The `math/` shadow engine (reused as a library)

26 files, ~2,600 lines, zero production callers (grep-verified). Reused
directly: `gameHrProbability.ts` (hazard-process conversion
`1-(1-p)^n`), `estimatePregamePaDistribution.ts` (PA-count distribution),
`shrinkRates.ts`/`normalizeStats.ts` (empirical-Bayes shrinkage), 8 tested
component scorers, `leakageGuard.ts` (pregame-only boundary enforcement,
imported directly by this PR's feature builder), `fitShadowTermWeights.ts`
(dormant walk-forward logistic fitter — PR2's engine),
`calibratePregameHrProbability.ts` (identity pass-through seam for PR2's
calibrator). Not reused/extended in this PR: `rankPregameCandidatesV2.ts`
(a ranking/tiering presentation layer, not a probability model).

## B. Feature-Source Matrix

Classification: **AVAILABLE** (fetched + used somewhere) · **DERIVABLE** (raw
data exists, specific stat not computed) · **NEW_FETCH** (no source at all)
· **DEAD-WIRED** (computed correctly, zero callers).

| Feature family | Status | Evidence | Note |
|---|---|---|---|
| Batter season power (xISO/xSLG/xwOBA/barrel/hardHit/EV/maxEV/FB%/HR-FB/pull%/sweetSpot) | AVAILABLE | `dataSources.ts:642-711` | Season aggregate; feeds champion + `math/` + this PR's capture. |
| Batter per-pitch-family xSLG/whiff (3 families) | AVAILABLE | `dataSources.ts:204-263` | Not per-specific-pitch-type. |
| Pitch-arsenal matchup (`batterXslgVsDominantFamily`) | now wired for V2 | `pitchFamilyMatchup.ts:21-41`, called from the V2 capture tap | Champion still hardcodes `null` (frozen, untouched). |
| Bat speed, swing length | AVAILABLE, 2 of 10 batTracking leaves | `dataSources.ts:633-636` | Remaining 8 leaves stay null — `BaseballSavantData` exposes no batter-side raw-swing rows for `batTrackingResearch.ts` to consume yet; **documented gap for PR3, not fabricated in this PR.** |
| Squared-up rate, blast rate | NEW_FETCH — confirmed absent | `batTrackingResearch.ts:11-12` | No source anywhere; stays null by design. |
| Contact-opportunity (K%, BB%, whiff%, contact%, zone-contact%, chase%) | now DERIVABLE via the sufficient-stats archive (this PR) | `plateHrV2SufficientStats.ts` — computed from the same raw per-pitch Savant rows `fetchBaseballSavantData` already parses and previously discarded | Populated in the new `plate_hr_v2_sufficient_stats` archive; the `contactOpportunity` feature *group* itself stays null in PR1 (PR3 wires the named-feature producer) — the underlying evidence is no longer thrown away. |
| Pitcher HR/9 + ERA vs. hand | AVAILABLE, used in production | `dataPullService.ts:1349-1387` | Champion's only pitcher input. |
| Pitcher contact-allowed (barrel/hardHit/FB allowed) | AVAILABLE, wired into V2 at full weight | `rawPitcherContactSnapshot.ts:125-267` | Zero-weighted by champion policy only; V2 uses it directly. |
| xHR allowed (pitcher), xHR-from-batted-ball (batter) | NEW_FETCH — confirmed absent | 0 matches anywhere in repo | Needs a new derived model (PR3+), itself dependent on the historical archive this PR starts collecting. |
| Bullpen HR/9 vs. hand (pregame projection) | NEW_FETCH | `mathTypes.ts:143-151`'s fields exist only in type/scorer/test fixtures | Live bullpen usage requires relievers already in-game — structurally not pregame. |
| Park HR factor, handedness-specific | AVAILABLE, wired | `dataSources.ts:283-324,356-376` | Already in production and in V2's capture. |
| Pull-side park geometry (fence distance/height by hand) | wired for V2 (this PR) | `parkDimensions.ts:114-141` (`getPullSideParkGeometry`) | Real 2026 Statcast dimensions, all 30 parks. |
| Temperature, wind speed/direction, roof status | AVAILABLE, wired | `parkWeatherScore.ts:15-17,53-73` | |
| Humidity, barometric pressure | AVAILABLE (fetched), used by no scorer | `dataPullService.ts:2037-2038,151-153` | Fetched for an air-density adjustment never built. |
| Air density (derived) | DERIVABLE, formula not implemented | 0 matches for `airDensity` | PR3 scope. |
| Confirmed batting lineup + slot | AVAILABLE, wired | `rosterService.ts:197-234` | No "projected" fallback state. |
| Team implied runs, OBP-ahead | DEAD-WIRED — hardcoded `null` | `buildPregamePowerRadar.ts:612-613,1045-1046` | Same gap in champion and V2 capture; implied runs likely need an odds feed (none today). |
| Probable starter + throwing hand | AVAILABLE, "never guess" null-guard | `rosterService.ts:238-291` | |
| HR odds / market confirmation | NEW_FETCH — confirmed absent | No odds source wired anywhere | `math/`'s `scoreMarketConfirmation` stays a no-op. |
| Historical per-PA/per-BBE archive | NEW_FETCH (infrastructure) | See §C | This PR's core deliverable. |

## C. Historical Reconstructability

No table anywhere stored structured historical per-PA or per-pitch data at
the granularity a walk-forward backtest needs, prior to this PR:

| Table | Grain | Why it wasn't enough |
|---|---|---|
| `contact_events` | Per-batted-ball, live-collected | Only 8 fields — no xBA/xSLG/xwOBA/spray/zone, no PA/count/situational context. |
| `game_player_stats` | Per-game box score | No per-PA granularity. |
| `batter_rolling_snapshots` | Daily point-in-time, 3 rates | Purpose-built for one prior backtest, not a general archive. |
| `pregame_power_radar_signals`/`_builds` | Model **output**, not raw input | `comparePlateModels.ts`'s own header: "The Plate has never persisted its raw pregame inputs." |
| `hr_radar_evaluation_snapshots` (+4 sibling tables) | HR Radar **Live** only | Richest existing pattern, but scoped to the in-game engine, zero rows, not a pregame archive. |

**This PR's contribution:** `plate_hr_v2_feature_snapshots` (one row per
game-day candidate, mutable-until-locked at first pitch),
`plate_hr_v2_sufficient_stats` (one row per player per as-of-date, the
"separate historical aggregate/archive layer" — season-to-date pitch-level
sufficient statistics computed from rows Savant's CSV already returns and the
existing code already discards), `plate_hr_v2_labels` (whole-game HR outcome
labels, append-only, versioned), `plate_hr_v2_model_registry` (versioned
model-artifact metadata, schema only — no fitter exists yet). All four are
schema-only until a deployment sets `PLATE_HR_V2_FORWARD_CAPTURE_ENABLED`.

## D. Highest-Value Immediately Usable Features (for PR2/PR3 planning)

1. **Real pitch-arsenal × hitter-damage matchup** — genuine conditional
   matchup information (what this pitcher throws × what this hitter
   destroys), not a restatement of general quality. The champion's own dead
   `batterXslgVsDominantFamily` socket proves the product already wanted
   this.
2. **Pitcher contact-allowed (barrel/hardHit/FB allowed) at full weight** —
   already computed and plumbed, just policy-gated to zero for the champion.
3. **Bat-tracking (bat speed, fast-swing rate)** — real, tested, 2 of 10
   leaves wired in this PR; the rest await a raw-row producer (PR3).
4. **Pull-side park geometry** — real, tested, strictly better than a
   generic park factor.
5. **Handedness-specific park factor** — already in production.

## E. Blocked / Deferred Features (confirmed, not fabricated)

- Squared-up rate, blast rate — no Statcast source ingested anywhere.
- xHR allowed (pitcher), xHR-from-batted-ball (batter) — no source; needs a
  new derived model built on this PR's historical archive.
- Bullpen HR/9 vs. hand as a true pregame projection — no producer.
- HR market odds / no-vig probability — no feed wired anywhere.
- Team implied runs — likely needs an odds feed too.
- Zone/location interaction — no source; `scoreZoneLocationInteraction`
  stays a permanent no-op until sourced.
- True zone-swing/zone-contact/chase-rate computation depends on a `zone`
  (or `plate_x`/`plate_z`) column being present in Savant's `type=details`
  export — likely present per Savant's standard schema, but not confirmed
  against a live response in this session. `plateHrV2SufficientStats.ts`
  reads it defensively and reports `zoneDataAvailable: false` rather than
  assume, whenever no row in a batch has a parseable zone code.

## PR1 scope note

Per the mission spec's own phased-delivery instruction, this PR is data and
contracts only: the feature-source audit (this document), the historical
training-row contract + persistence schema, an as-of-date feature builder,
the V2 frozen-input contract, forward feature capture (default OFF), and
leakage tests. No model-fitting code, no probability wiring, no production
authority — that is PR2, a separate future change. No change whatsoever to
`plate_jul20_restored_v1` or `plate_current_shadow_v1`.
