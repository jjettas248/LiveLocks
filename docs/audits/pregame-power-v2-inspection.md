# Pre-Game Power Radar — v2 Inspection Audit (Phase 0)

**Scope:** `server/mlb/pregamePowerRadar/**` only. Read-only inspection of the
current production engine ahead of the v2 **shadow** math core. No production
file is modified by this work.

**Companion docs:** `pregame-power-leakage-contract.md`,
`pregame-power-stat-coverage.md`, `pregame-power-missing-data.md`,
`pregame-power-v2-math-framework.md`, `pregame-power-v2-future-phases.md`, and the
prior `pregame-power-engine-current-state.md` (PR #45).

> **Precondition:** PR #45 (canonical PowerPrior contract + shadow bridge) is
> merged to `main` (commit `431e3a8`; PR #46 merged on top). This work began from
> that baseline on branch `claude/relaxed-feynman-tkbeda`.

---

## 1. Current file map

| File | Role |
| --- | --- |
| `buildPregamePowerRadar.ts` | Pure per-batter build orchestrator (storage-free). Pulls upstream data, runs components, composes score. |
| `scoring.ts` | Final composition: weighted component avg → BvP modifier → coverage caps → matchup penalty → `score10`, tier classification, suppression. |
| `scoreUtils.ts` | Shared pure helpers (`lin`, `clamp10`, `weightedAvg`). |
| `types.ts` | Canonical types (`PregamePowerSignal`, `PregamePowerDiagnostics`, `PregamePowerTier`, drivers, contracts). |
| `batterPowerProfile.ts` | Component: batter true power (0–10). |
| `pitcherVulnerability.ts` | Component: pitcher handedness HR vulnerability (0–10). |
| `matchupFit.ts` | Component: handedness/OPS/family + BvP modifier (0–10). |
| `parkWeatherScore.ts` | Component: park HR factor + wind + temp (0–10). |
| `lineupOpportunity.ts` | Component: slot volume + run env + OBP-ahead (0–10). |
| `batterOrderSplit.ts` / `pitcherOrderSplit.ts` | Slot-production splits (pitcher split has no producer yet). |
| `marketTagger.ts` | Per-market tags + qualitative setup labels (no score weight). |
| `playerParkWindFit.ts` | Display-only park/wind fit (no score). |
| `pregamePowerRadarService.ts` | TTL cache, rebuild, DB fallback resolution. |
| `pregamePowerRadarStore.ts` | In-memory snapshot singleton. |
| `pregamePersistence.ts` | DB sink (build → tables) + DB-fallback loader. |
| `shadowOutcomes.ts` | Read-only live bridge + box-score grading (writes only to pregame store). |
| `diagnostics.ts` | Public-visibility predicate + outcome summary. |
| `liveBridge.ts` / `liveBridgeCore.ts` | Read-only pregame→live ladder badge map. |
| `*.test.ts` (8) | Plain-`tsx` assertion suites. |

**New (this work, additive, SHADOW-ONLY):** `server/mlb/pregamePowerRadar/math/**`
— 19 pure modules + 5 `*.test.ts`. Nothing outside `math/` imports them.

## 2. Current data flow

```
upstream data (rosterService, dataPullService, dataSources: Savant/MLB/park/weather)
   → buildPregamePowerRadar (pure)
   → components (batterPower, pitcherVuln, matchupFit, parkWeather, lineupOpp, marketTags)
   → scoring.composePregameScore → score10 + tier + drivers + suppressedReasons
   → pregamePowerRadarStore (in-memory snapshot)
   → pregamePersistence (DB: pregame_power_radar_signals + _builds)
   → consumers: public/admin API, powerPrior mapper (read-only), live ladder badge bridge
   → shadowOutcomes (5-min cron): read-only live bridge + final box-score grading
```
Triggers: boot build (+90s), 15-min rebuild tick, 5-min shadow grader (`server/index.ts`).

## 3. Current score formula (weighted composite — NO probability)

`scoring.ts`:
```
baseScore   = Σ componentScore × weight        (all components 0–10)
bvpAdjusted = clamp(baseScore + bvpModifier, 0, 10)
capped      = applyCoverageCaps(bvpAdjusted, flags)
score10     = round1(clamp(capped − matchupPenalty, 0, 10))
```

### Component weights
| Component | Weight |
| --- | --- |
| batterPower | 0.30 |
| pitcherVulnerability | 0.25 |
| matchupFit (incl. BvP) | 0.20 |
| parkWeather | 0.15 |
| lineupOpportunity | 0.10 |

### Tier thresholds (`classifyTier`, gated)
- `power_watch`: batterPower ≥ 7.0 AND pitcherVuln < 5.5
- `nuclear`: score ≥ 8.8 AND batter ≥ 7.0 AND pitcher ≥ 6.0 AND !eliteBlocked
- `elite`: score ≥ 7.3 AND batter ≥ 7.0 AND pitcher ≥ 6.0 AND !eliteBlocked
- `strong`: score ≥ 6.8 AND batter ≥ 6.7 AND pitcher ≥ 5.5 (or ≥ 6.0 publish floor)
- `watch`: 4.0–5.9 · `track`: < 4.0
- `eliteBlocked` = negative BvP / zero-production BvP / suppressive pitcher-slot / weak batter-slot.

### Coverage caps (`computeDataCoverage`)
`coverage = batterPower(.35)+pitcher(.25)+lineup(.20)+park(.10)+weather(.05)+bvp(.05)`.
Caps: no batter power → 3.9; no pitcher → 5.9; coverage < 0.6 → 5.9; park-only & no weather → 5.9.

## 4. Input coverage (today)

Used: batter Statcast power (xISO/xSLG/xwOBA/barrel/hardHit/EV/maxEV/FB%/HR-FB/pull%/sweetSpot),
pitcher HR/9 + ERA vs hand, batter OPS-vs-hand + xSLG-vs-family, BvP (capped modifier only),
park HR factor (overall), wind/temp forecast, batting-order slot, team implied runs.

Available but unused: park HR factor **by handedness**, batter pitch-type whiff splits,
bat-tracking (bat speed / swing length), rolling 7/15/30 trends, pitcher pitch-mix.

Missing/no producer: pitcher barrel/hardHit/FB **allowed**, pitcher-by-order-slot,
bullpen vulnerability, HR prop odds (no source at all), zone/location splits.

(Full classification → `pregame-power-stat-coverage.md`.)

## 5. Output shape
`PregamePowerSignal` (`types.ts`): `score10` (0–10), `tier` (label-only), `drivers[]`,
`marketScores`, `parkContext`, `diagnostics` (component sub-scores, coverage, penalties,
suppression). **No per-PA or game HR probability field exists.**

## 6. Current tests
8 plain-`tsx` suites: scoring boundaries, batter/pitcher order splits, directionality
regression, park/wind display contract, park/weather carry, market tagger, live bridge.
Pure/unit + a couple of integration + a git-diff guard against HR-Radar edits. No
backtest harness, no calibration test, no probability test exists today.

## 7. Risks identified
1. **Score ≠ probability.** Tiers are weighted-score thresholds, not calibrated HR
   chances — Elite/Strong/Watch ordering is unproven against outcomes.
2. **No volume model.** Batting-slot affects PA count (HR opportunity) only weakly,
   via a small lineup component on a per-game score.
3. **Unused signal.** Handedness park factor, pitch-type splits, bat-tracking exist
   but never reach the score.
4. **Forked pregame logic** (noted in PR #45): standalone module vs. the inline prior
   in `hrConversionModel.ts` — out of scope here (do not touch).
5. **No odds source.** Market confirmation cannot be wired yet.

## 8. Files proposed for this task (all additive)
- Code (shadow-only): `server/mlb/pregamePowerRadar/math/**` (19 modules + 5 tests).
- Docs: the six `docs/audits/pregame-power-*.md` listed at the top.
- **Not touched:** any production file under `pregamePowerRadar/` (scoring, build,
  service, store, persistence, components), any HR-Radar/live/engine file, client UI,
  DB schema. Confirmed by `git status` (only `math/` is new) and by grep (nothing
  outside `math/` imports the new module).

## 9. Phase-0 checkpoints (from task) — status
- A backtest harness already exists? **No.** (Per the approved scope change, the
  backtest is intentionally **not** built — see future-phases doc.)
- A math core already exists? **No** — production is a weighted scorer; v2 math core is new.
- Historical outcome data joinable safely? Outcomes persist in
  `pregame_power_radar_signals`, but **no `DATABASE_URL`/historical archive exists in
  this environment**, so no backtest can run here — deferred by design.
- Implementation differs materially from assumptions? No; matches the PR #45 audit.
