# HR Radar Engine — Audit & Sharpening Roadmap (June 2026)

> **Trigger:** HR Radar surfaced **206 "MISSED" vs ~6 conversions in a single day**. The product read
> ("not a strategic engine — spray-and-pray — we're calling everything a home run") is correct. This
> document separates the two tangled root causes, then lays out a phased plan to make the radar
> strategic, honestly graded, EV-aware, and more accurate.
>
> **Status:** Audit + roadmap only. No engine/runtime code is changed by this document. Implementation
> follows in subsequent PRs under the discipline in `CLAUDE.md` §7a (sanctioned engine changes).

---

## 0. Executive summary

Two distinct problems are being conflated:

1. **Accounting/funnel (why it *looks* like spray-and-pray).** Nearly every batter who makes decent
   contact gets a canonical `watch` signal, and at game-final **every still-active non-HR signal is
   stamped `called_miss`**. Ambient *tracking context* is counted as if it were a *betting pick*. The
   UI string "did not convert before the window closed" is cosmetic — **there is no PA/time window and
   no expiration clock**; "window closed" simply means the game ended. So the **206 "misses" ≈ every
   batter we ambiently watched who didn't homer**, not 206 failed bets.

2. **Model (why there's no strategic edge).** The conversion probability is a large hand-tuned
   multiplier stack that is **never calibrated against realized outcomes** and **never compared to the
   HR prop market price** (`batter_home_runs`, which we already ingest). There is no concept of
   edge/EV, and no honest measure of *lift over the ~12%/game base rate*.

**Direction (approved):** collapse the ladder to **3 tiers — Watch → Building → HR Max Window** — promote
through Watch/Building faster, **grade only the HR Max Window tier** as a real pick, **EV-gate** that
tier against the market, and **improve the underlying probability** with new stats, an explicit
hard-hit interaction term, and a closed calibration loop.

---

## 1. Audit findings (what exists today)

### 1.1 The funnel has no top-of-funnel selectivity
- `server/mlb/liveGameOrchestrator.ts` runs a **periodic roster scan** (`HR_ROSTER_SCAN_INTERVAL_MS`,
  ~lines 2809–2859) that feeds **every batter with any plate appearance** into the near-HR detector. No
  HR-likelihood pre-filter.
- `server/mlb/nearHrContact.ts` **WATCH** tier fires on `EV≥98 + LA[20–35] + dist≥350` — i.e. **any
  well-struck fly/line out**. Dynamic-state gates (`server/mlb/hrAlertEngine.ts` ~lines 201–203):
  `WATCH ≥ 0.05`, `PREPARE ≥ 0.06`, `BET_NOW ≥ 0.10` — all *per-PA*. At a ~3.3%/PA league base over
  ~4 PA, a large fraction of the slate clears 5%.
- **Consequence:** the `watch` state is *ambient context*, not a pick. That's fine — but today it is
  graded as one.

### 1.2 "MISSED" is an inflated denominator
- `server/mlb/hrRadarStateMachine.ts`: terminal `missed` is produced by a `GAME_FINAL` event on **any
  still-`active`** signal (watch/build/ready/fire). Terminal states are sticky.
- `server/storage.ts` `reconcileHrRadarAlertsForGame()` (~lines 4478–4614): at `status:"final"`, every
  live HR Radar alert whose player is **not** in the box-score HR map is stamped `called_miss`
  ("reconcile: game ended without HR for this called signal", ~line 4588).
- The humanized UI text "Signal was tracked and did not convert before the window closed"
  (~`storage.ts:5906`) is **cosmetic** — there is **no PA/time window and no expiration clock** in the
  lifecycle. A signal can decay `fire → watch` over several innings and still be counted as a miss at
  game-final.

### 1.3 The probability model is rich but uncalibrated and price-blind
- `server/mlb/hrConversionModel.ts` is a sequential multiplier stack on a `0.033`/PA base
  (handedness-blended 70/30), with **capped** components:
  - live contact (≤×2.5, ~lines 215–251), barrel (≤×1.5), contact-quality anchor (xwOBA/xSLG),
    pitcher fatigue/ERA/HR9/velo (≤×2.0), environment park/wind/temp/humidity/pressure/pitch-mix
    (≤×1.35), pregame power form, recent form, IBB "feared slugger" prior, lineup slot.
  - Final per-PA clamp `[0.005, 0.12]`, then converted to game-level **P(≥1 HR)** via a PA distribution
    and a **static calibration table** (~lines 163–178).
- **The calibration table is hand-set, not learned.** An empirical-bucket hook exists but is not
  populated from a closed feedback loop tying `convProb` → realized HR.
- **The market price is never consulted.** `batter_home_runs` exists (`server/oddsService.ts:1212`) and
  flows through the prop-edge engine (`markets.ts` / `backtestHarness.ts`), but the **HR Radar live
  track is a separate pipeline that ignores it.** No edge, no EV, no "only fire when model > market".

### 1.4 Data inventory — strong, with specific gaps
**Already ingested and usable** (`server/mlb/dataSources.ts`, `dataPullService.ts`):
- Statcast season profile: barrel%, xISO, xwOBA, HR/FB, FB%, pull%, sweet-spot%, **bat speed**, swing
  length.
- Rolling **AVG/OPS/HR-rate** (L7/L15/L30); handedness splits (HR/AB & OPS vs LHP/RHP); BvP history.
- Live per-AB contact: EV / LA / distance / per-AB xBA / barrel flag / outcome / hit-type.
- Pitcher: season + handedness (ERA, HR/9 vs LHB/RHB), recent-start fatigue, **live pitch mix & velo
  trend**, bullpen usage.
- **Handedness-aware park factors** (`PARK_FACTORS.hrLHB / hrRHB`); live + Open-Meteo weather
  (temp / wind / humidity / **pressure**). Live state: inning, outs, runners.

**Missing / referenced-but-unused / under-leveraged:**
- **Handedness park factor unused in the live model** — `hrLHB/hrRHB` exist but the environment
  multiplier uses the *generic* `hr` factor, ignoring short-porch pull effects.
- **No rolling Statcast quality** — we have rolling AVG/OPS/HR-rate but **not** rolling
  barrel%/hard-hit%/xISO (L7/L15). A hitter can be hot in OPS but cold in power.
- **No batted-ball-type weighting per AB** — a 96-EV line drive is scored like a 96-EV fly ball.
- **Bat speed ingested but unused** — `avgBatSpeed`/`avgSwingLength` feed nothing in the model.
- **No interaction term** — EV/hard-hit, xBA, launch angle, bat speed, and IBB are scored as
  *independent* components. Real-world truth is multiplicative: **a hard-hit / high-xBA ball paired with
  a favorable launch angle + high bat speed (or a feared-slugger/IBB profile) is overwhelmingly likely
  to be a HR** — the additive stacking under-rewards that co-occurrence.
- **No count/leverage feature**; **no pitcher pitch-type HR vulnerability** (we have pitch-mix %, not
  HR-per-pitch-type allowed); **market line / steam unused** as a feature; **wind-shift detected but not
  fed** into the conversion model (logging only).

---

## 2. Target design

### 2.1 Collapse to a 3-tier ladder; grade only the top tier
Map the current `inactive→watch→build→ready→fire→{cashed,missed,expired}` machine onto **3 visible
tiers**, promoting faster:

| New tier | Sourced from | Meaning | Graded as a pick? |
|---|---|---|---|
| **Watch** | `watch` | Ambient: live contact / near-HR evidence building | **No** — context only |
| **Building** | `build` + `ready` collapsed | Real power threat forming; near-actionable | **No** — context only |
| **HR Max Window** | `fire`, EV-gated | Actionable bet, inside a bounded window | **Yes** — only this counts |

- **Promote quicker:** collapse `ready` into Building and lower the Building→HR-Max sustain requirement
  (today `READY_TO_FIRE_SUSTAIN_TICKS=2` + strong driver), so genuine threats reach the actionable tier
  in fewer ticks instead of stalling in a 4-stage gauntlet.
- **Honest grading (core fix):** **Watch/Building never produce `called_miss`.** Only a signal that
  **entered HR Max Window** can resolve to `cashed`/`missed`. This converts "206 misses" into a small,
  defensible actionable set. Watch/Building roll up separately as *context volume*.
- **A real "window":** HR Max Window expires after a **bounded PA horizon** (e.g. the batter's current +
  next plate appearance, or a short clock), producing `expired` (not `missed`) when the window passes —
  so "window closed" finally means what it says.

### 2.2 EV-gate the HR Max Window against the market
- Join the live `batter_home_runs` price (`server/oddsService.ts`) to the HR Radar candidate by
  `sport:gameId:actorId:home_runs`.
- Convert American odds → implied prob, de-vig, and require
  **model game-P(HR) ≥ marketImplied × (1 + margin)** (start margin ~10–15%) for HR Max Window entry.
- Surface `modelProb`, `marketImplied`, `edgePct` on the signal so the UI shows *why* it fired.
- Keep this **inside the engine layer before the bus** as a new **optional** input (no-op when price
  absent, per §7a #2) so partial odds coverage never destabilizes runtime.

### 2.3 Sharpen the underlying probability (engine layer, §7a-sanctioned)
Additive, capped, no-op-when-absent. In priority order:

1. **Close the calibration loop.** Persist every HR-Max candidate's `convProb` + realized outcome;
   build **empirical calibration buckets** from real data and replace the static table
   (`hrConversionModel.ts` ~163–178). Report **calibration error + lift over base rate** as the new
   success metric instead of raw hit-count.
2. **Hard-hit × angle × bat-speed × IBB interaction booster (high priority).** Add an explicit
   *multiplicative interaction*: when a **hard-hit ball (EV high) OR high xBA (`perABxBA ≥ ~0.65`)**
   co-occurs with a **favorable launch angle**, **elite bat speed** (`avgBatSpeed`, currently unused),
   and/or a **feared-slugger/IBB** profile, apply a compounding boost on top of the independent live-
   contact term. This wires bat speed in for the first time and ties the IBB prior to live contact
   quality. Capped per §7a #4 (cannot breach Phase 1.5 caps); no-op when any input is absent. Files:
   `nearHrContact.ts` (contact classification) + `hrConversionModel.ts` (live-contact section ~215–251).
3. **Wire handedness park factor** — use `PARK_FACTORS.hrLHB/hrRHB` in the environment multiplier keyed
   on batter hand; capped; replaces the generic `hr` factor when present.
4. **Rolling Statcast power trend** — add L15 rolling barrel%/hard-hit%/xISO to the form multiplier (new
   sync in `dataPullService.ts`, additive multiplier in `hrConversionModel.ts`).
5. **Batted-ball-type weighting** — discount line-drive/ground contact vs fly contact in the live
   contact multiplier (`nearHrContact.ts`).
6. **Pitcher pitch-type HR vulnerability** — fold HR-per-pitch-type (Savant) into the pitcher multiplier
   where available.
7. **Market steam as a soft feature** — optional small nudge when `batter_home_runs` line shortens.

Each new input: returns `1.0`/`null` when data absent, respects Phase 1.5 caps, and gains a regression
case before merge (§7a #2,#4,#6). Re-baseline `MLB_GOLDMASTER_VERSION` (`server/mlb/goldmasterGuard.ts`)
whenever behavior changes on purpose (§7a #5) — the resulting `[MLB_DRIFT_WARNING]` is expected, not a
regression.

---

## 3. Phased implementation plan

### Phase 0 — Instrument & prove the leak (no behavior change)
Log, per resolved signal, the **max tier it reached** and outcome; emit a daily breakdown of misses by
max-tier. Confirms the 206 misses are dominated by Watch/Building.
- Files: `server/mlb/liveGameOrchestrator.ts`, `server/analytics/hrRadarIntelligence.ts` (read-only).

### Phase 1 — 3-tier ladder + honest grading (biggest credibility win)
- Collapse `ready`→Building; define the `HR Max Window` mapping.
  Files: `hrRadarStateMachine.ts`, `hrRadarUserStage.ts`, `hrRadarSection.ts`, `hrRadarState.ts`.
- Restrict `called_miss`/`cashed` to signals that entered HR Max Window; introduce PA-bounded `expired`.
  Files: `server/storage.ts` (`reconcileHrRadarAlertsForGame`), `hrRadarOutcomeStamp.ts`.
- UI: 3 sections + separate "context volume" count.
  Files: `client/src/components/mlb/HrRadarLadder.tsx`, `client/src/pages/mlb-live.tsx`.
- Tests: extend `hrRadarStateMachine.test.ts`, `hrRadarReadyToFire.test.ts`,
  `hrRadarLifecycleRepair.test.ts`, `server/validation/hrRadar/ladderInvariants.ts`.

### Phase 2 — EV-gating against `batter_home_runs`
- Join market price into the HR Radar candidate; de-vig; gate HR Max Window on edge margin; add edge
  fields to the payload (intentional shape change → bump goldmaster).
  Files: `hrAlertEngine.ts`/`evaluateHRAlert.ts` (gate) + a new join helper reading `oddsService.ts`.

### Phase 3 — Probability accuracy
- Calibration loop + the new/under-used stats and the hard-hit interaction booster from §2.3.
  Files: `hrConversionModel.ts`, `nearHrContact.ts`, `dataPullService.ts`, `dataSources.ts`,
  `goldmasterGuard.ts`; new cases in `hrCalibration.test.ts` and the regression suites in `CLAUDE.md §1`.

**Sequencing rationale:** Phases 0–1 fix the spray-and-pray *perception and accounting* immediately and
are low-risk; Phase 2 makes the top tier *strategic* (EV-gated); Phase 3 raises raw accuracy. Each phase
is independently shippable.

---

## 4. Success metrics (replace raw hit-count)

- **Calibration error** on the HR Max Window tier (predicted P(HR) vs realized), bucketed.
- **Lift over base rate**: realized HR rate of HR-Max picks ÷ ~12% league game base.
- **ROI vs market** at the de-vigged `batter_home_runs` price (the EV the tier was gated on).
- **Context volume** (Watch/Building counts) reported separately and **never** as misses.

---

## 5. Regression gates (must pass before any engine PR merges)
Per `CLAUDE.md §1`:
```
npx tsx server/mlb/phase3bRegression.test.ts
npx tsx server/mlb/shadowOutcomeWiring.test.ts
npx tsx server/mlb/hrRadarLifecycleRepair.test.ts
npx tsx server/mlb/hrRadarStateMachine.test.ts
npx tsx server/mlb/hrRadarReadyToFire.test.ts
npx tsx server/mlb/nearHrContact.test.ts
npx tsx server/mlb/pullAndPregame.test.ts
npx tsx server/mlb/ibbAndRecentForm.test.ts
```
Plus `npx tsc --noEmit` clean, and a re-baselined `MLB_GOLDMASTER_VERSION` for any intentional behavior
change.
