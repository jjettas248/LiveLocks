# Live HR Radar — End-to-End Diagnostic Audit

**Status:** Diagnosis only. No scoring/production behavior changed.
**Method:** Six parallel code audits (data-fetch, caps/suppression, scoring/section/display,
orchestrator/timing, routes/frontend, outcome-attribution/backtest), each with file:line
evidence, plus direct verification of the two load-bearing findings.
**Environment note:** This container has **no `DATABASE_URL` and no `ODDS_API_KEY`**, so a live
backtest over stored games could not be executed here. The data needed to run it exists in
production (`hr_radar_signal_events`, `hr_outcomes`, `hr_radar_alerts`); the runnable harness
design + exact queries are in §9.

---

## 0. TL;DR — Is the HR Radar failing for the same reason the Pre-Game Power Radar failed?

**Partially yes, but the failure has moved.** The Pre-Game Power Radar bug was *fatal*: a broken
handedness feed → missing pitcher vulnerability → a hard cap below publish threshold → 0 targets.
The **live HR Radar has largely adopted the corrected "missing = neutral, not suppressing"
discipline in its scoring consumers** (handedness multipliers, near-HR detector, conversion
blends all no-op on null). So the live radar is **not** producing zero targets the way pregame did.

**But three classes of the *same underlying defect* survive in the live radar:**

1. **One layer still treats missing data as worst-case.** `HRSignalBuilder.classifyContactEvent`
   coerces null EV/LA/distance → `0` (verified, `HRSignalBuilder.ts:180-182`), silently demoting a
   real HR-shaped ball with a dropped Statcast field to `noiseContact` — **with no suppression
   reason emitted at all.** The sibling module `nearHrContact.ts:247-263` does the opposite
   (preserves null, emits explicit `missing_statcast`). The two layers contradict each other.

2. **Suppression labels lie about cause.** The conv-watch / EV-edge gates
   (`evaluateHRAlert.ts` S2/S4) fire on a probability that may have been deflated by *data
   fallbacks* (league-average baseRate when season HR rate + barrel are both missing; overlay
   barrel-dampening on a `0`), yet they log "below watch min / EV-gated" — attributing a **data
   gap** to **low HR likelihood**. This is exactly the mislabeling the pregame post-mortem warned
   about, now living on the probability side where no `missing_*` reason is ever produced.

3. **The data/identity/cache layer still conflates empty with low.** Transient-empty Savant
   responses are negative-cached for 4h; empty `byHand` splits are cached all-null for 24h; a
   failed roster sync silently nulls **every** batter's handedness fleet-wide with no diagnostic
   tag. None are fatal anymore (consumers neutralize them), but "data unavailable" is still
   indistinguishable from "player is weak."

**Beyond the pregame-class defect, the live radar has two failure modes pregame never had**
(because pregame is static): it is **structurally late** (AB-granularity detection + 6–27s
cadence/dedup + multi-cycle sustained-conviction gate ⇒ the first time many HRs are "noticed" is
the HR itself), and its **outcome attribution under-credits the engine** (a correct fire that
decayed before the HR, or a correctly-surfaced watch/build that homered, both record as
`uncalled_hr` — neither a win nor a counted miss). These make the engine *look* far worse than it
is, independent of scoring quality.

**Bottom line on root cause (ranked):**
1. **Late event detection / promotion timing** (structural) — biggest driver of "manual beat the engine."
2. **Outcome-attribution under-credit** — makes whatever the engine *did* catch look like a loss.
3. **Missing-data-as-negative in `HRSignalBuilder` + suppression mislabeling** — pregame-class defect, residual.
4. **Negative caching / roster-miss in the data layer** — pregame-class defect, residual, non-fatal.
5. **Display mixing (peak vs current, un-banded readiness, client re-bucketing/share-card)** — makes good candidates *look* dead/misranked.

Scoring/threshold math itself is **not** the primary culprit. Do **not** lower thresholds or
inflate scores.

---

## 1. Are any components using invalid or stale API calls?

**No invalid params / wrong endpoints found.** All endpoints are well-formed and ID mapping is
correct (Baseball Savant correctly keys on MLBAM IDs, so reusing the statsapi `playerId` for
`batters_lookup[]`/`pitchers_lookup[]` is right; `savantId` is declared but unused — harmless).
statsapi `byHand` split URLs, season filters (`gameType=R`, current year), and stat groups are valid.

**Real issues are staleness / silent-empty handling, not bad params:**

| ID | Issue | File:line | Severity |
|----|-------|-----------|----------|
| D-4 | Savant **season** fetch caches an **all-null** result for 4h even on a transient empty/`[]` 200 (not an HTTP error, so the error-path stale-recovery never runs). A momentary empty → "no power data" for 4h. | `dataSources.ts:603,614-618` | High |
| P-2 | `byHand` splits cache an **all-null object for 24h** on empty-array responses; empty is indistinguishable from parse-miss; no flag. | `dataPullService.ts:1128-1129,1140,1169` | High |
| D-2 | statsapi fallback substitutes real **AVG→xBA** and **SLG→xSLG** with no flag — wrong-semantics values consumed as expected stats. | `dataSources.ts:534-535,630-631` | Medium |
| D-3 | Stale Savant cache served through the **same shape as fresh** with no upper staleness bound on repeated errors. | `dataSources.ts:614-618` | Medium |
| P-3/X-1 | Missing→neutral-*value* coercions (`windDirection="cross"`; `classifyContact(null,null)`→`xBA:0/"weak"`). Currently guarded by callers; latent traps. | `dataPullService.ts:1199,1717`; `statcastXBA.ts:148-155` | Low |

**Silent empty responses treated as weak data?** Mostly fixed at the *consumer* (good), but
**still present at the cache/identity layer** (D-4, P-2, R-1 below). The per-game Savant feed is the
gold standard — it never overwrites good cache with an empty result (`dataSources.ts:726-735`); the
season fetch and split fetch should copy that pattern.

---

## 2. Are missing inputs treated as negative evidence?

**Two contradictory philosophies coexist in the codebase:**

- **Correct (missing = neutral / no-op):** `nearHrContact.ts` (preserves null, emits `missing_statcast`/`no_at_bat`),
  `computeHandednessERAMultiplier` (`return 1.0` on `!splits`), the matchup HR-rate blend
  (`if matchupHRRate != null …`), `buildConversionInput` league-average defaults
  (`battingOrderSlot ?? 5`, `parkFactor ?? 1.0`, etc. — additive, neutral).
- **Wrong (missing = worst-case):** **`HRSignalBuilder.classifyContactEvent` (`HRSignalBuilder.ts:180-182`)**
  — `ev = exitVelocity ?? 0; la = launchAngle ?? 0; dist = distance ?? 0`. A real AB with a dropped
  Statcast field is classified `noiseContact`, starving `hrShapedCount` / `eliteHrCount` /
  `missedHrCount` / `barrels` — the inputs to **every** FAST_PROMOTE tier and PATH_A/B/C. **No
  suppression reason is emitted; the candidate just never qualifies.** This is the single most
  damaging missing-data behavior and the closest live analog to the pregame bug.

**Where null/empty becomes score reduction / downgrade / hidden:** see the cap/suppression table
in §3. The dangerous ones are **Flag A** (above), **Flag B** (overlay barrel dampening on a `0`),
**Flag C** (conv gates firing on a fallback-deflated probability), and **R-1** (roster-miss nulls
all handedness).

**"Player is weak" vs "data unavailable" — current state:** the engine has the vocabulary for the
*latter* only inside `nearHrContact.ts`. The probability/builder side has **no** missing-data
reason class. Recommended explicit reasons to add (none exist today on the probability side):
`missing_batter_power`, `missing_pitcher_profile`, `missing_handedness_splits`,
`capped_by_data_quality`, `stale_statcast`, `no_recent_batted_ball_events`,
`below_threshold_with_full_data`, `below_threshold_with_degraded_data`.

---

## 3. Caps & suppression — full table + are true positives made invisible?

Promotion is governed by the **max** of two tracks (`hrAlertEngine.ts:68-83`): the PATH evaluator
(`evaluateHRAlert`) and the dynamic FSM (`deriveState`, thresholds BET_NOW 0.14 / PREPARE 0.07 /
WATCH 0.05). A probability cap only suppresses if it *also* blocks the PATH track, so the PATH
conv-gates (S2/S4) are the load-bearing suppressors.

### 3a. Probability / multiplier caps

| # | Cap (file:line) | Effect / max | Can drop below publish? | Negative evidence or **MISSING DATA**? | Reason truthful? |
|---|---|---|---|---|---|
| 1 | Final per-PA clamp `[0.005, 0.12]` (`hrConversionModel.ts:1006`) | top clamp 0.12; floor 0.005 | top-only | top=neg clamp; floor=missing-data safety | n/a |
| 2 | Calibration compression (`hrConversionModel.ts:186-203`) | calibrated cap 0.46 | **yes** (feeds 0.14/0.15 gates) | neutral/intentional | n/a |
| 3 | **baseRate league-avg fallback** (`hrConversionModel.ts:918-920`) | star modeled at 0.033/PA when seasonHR **and** barrel both missing | **yes** | **MISSING DATA** (neutral default, but strips edge) | none |
| 4–11 | liveContact ≤2.5, pitcher 0.80–2.0, env ≤1.35, powerProfile 0.88–1.28, handednessERA 0.88–1.12, entryFatigue 0.90–1.30, recentForm 0.90–1.15, pitchMix 0.88–1.18 | bounded multipliers | small | **negative evidence, all `!=null`-guarded** (missing = no-op) ✅ | n/a |
| 12 | **Overlay soft gate — barrel floor** (`subEngines.ts:211-217`, gateFloor 0.65) | ×0.65 haircut | **yes** | neg **only if `barrel!=null`**; **but `barrel=0` triggers MAX dampening** (Flag B) | internal `confidencePenalty` only |
| 13–14 | Overlay EV<87 / topped>25 gates | dampen | yes (combined) | negative, `!=null`-guarded ✅ | — |
| 15 | Overlay final clamp `[0.60,1.60]` (`hrOverlay.ts:60-63`) | can cut prob to 60% | **yes** | combination of 12–14 | risks array |
| 16 | Lineup Θ low-order (`subEngines.ts:163`) | negative component | small | negative; slot defaults to 5 when missing (neutral) ✅ | `LOW_ORDER_POSITION` |
| 17 | PREGAME_SEED_CAP 55 (`hrConversionModel.ts:893`) | seed ≤55, never fires | no (by design) | neutral ✅ | n/a |

### 3b. Suppression rules (these directly block/demote)

| # | Rule (file:line) | Effect | Drops below promo? | Negative or **MISSING**? | Reason truthful? |
|---|---|---|---|---|---|
| S1 | Hard veto remainingPA<0.5 w/o elite (`evaluateHRAlert.ts:235-237`) | VETOED → null | **yes** | negative; **but uses `slot??5`,`isHome??false`** (Flag E) | truthful |
| S2 | **Conv watch gate** convProb<0.03 (`evaluateHRAlert.ts:487-497`) | suppressed, `CONV_LOW` | **yes** | **fires on fallback-deflated prob** (Flag C) | **MISLEADING** ("below watch min") |
| S3 | Cooldown 10min (`evaluateHRAlert.ts:455-464`) | no alert | yes (temp) | neutral | truthful |
| S4 | **EV market-edge DEMOTE** model<mkt×1.10 (`evaluateHRAlert.ts:1412-1458`) | official→prepare, ALERT→WATCH | **yes** | **demotes if caps deflated modelProb** (Flag C) | mechanism truthful, cause not |
| S5–S9 | Soft vetoes: same-side, headwind, cold≤45, LA inconsistency, single early HR | cap tiers | yes | **negative, presence-guarded** ✅ | truthful |
| S10 | Pitcher-change ×0.85 (`hrAlertEngine.ts:412-414`) | 15% prob cut | yes | negative (both IDs required) | truthful |
| S11 | Decay staleness rail (`hrAlertEngine.ts:241-253`) | halves prob / 8min idle | **yes** | **neutral time, but suppresses on-deck candidate** (Flag F) | directionally true |
| S12 | Consecutive-decline cooldown ×3 (`hrAlertEngine.ts:331-333`) | COOLED_OFF | yes | structural | truthful |
| N1 | near-HR `missing_statcast` (`nearHrContact.ts:253-263`) | tier=null | yes | **MISSING DATA, correctly labeled** ✅ | **truthful** ✅ |
| N2/N3 | near-HR below_watch_threshold / no_at_bat | tier=null | yes | negative / missing, labeled ✅ | truthful |

### 3c. Caps that can suppress a true positive on MISSING DATA alone (flagged)

- 🔴 **Flag A — `classifyContactEvent` null→0** (`HRSignalBuilder.ts:180-182`). No reason emitted.
- 🔴 **Flag B — overlay barrel dampening on `barrel=0`** (`subEngines.ts:211-217`). `!=null` guard
  is correct for `null` but a rolled-up `0` triggers the full ×0.65; only an internal flag results.
- 🔴 **Flag C — conv gates S2/S4 fire on data-deflated probability** (`evaluateHRAlert.ts:487,1425`).
  The mislabel: "below watch min" / "EV-gated" when the true cause is missing upstream data.
- 🟠 **Flag D — baseRate league-avg fallback** (`hrConversionModel.ts:918-920`).
- 🟠 **Flag E — remainingPA hard veto with defaulted slot/home** (`evaluateHRAlert.ts:235` + `hrAlertEngine.ts:459`).
- 🟡 **Flag F — decay staleness rail** suppresses a still-valid on-deck candidate (`hrAlertEngine.ts:248-251`).

The well-guarded "player is weak" caps (4–11, 16, S5–S9, N2) are **justified** and should be left
alone.

---

## 4. Are suppression reasons truthful?

**Partially.** The **near-HR detector is honest** (`missing_statcast`, `no_at_bat`,
`below_watch_threshold` — `nearHrContact.ts`). The **probability/PATH side is not**: S2 logs
"below watch min … Suppressing" and S4 logs "EV-gated" even when the real cause is a data fallback
(Flag C). `HRSignalBuilder`'s null→0 demotion emits **no reason at all**. There is **no persisted
suppression reason** anywhere — the rich reasons live only in the in-memory `qualificationAudit`
ring buffer (50 cycles / 30 min) and are lost on restart.

**Recommended reason taxonomy** (add as a stamped, persisted field; map existing sites onto it):
`missing_batter_power`, `missing_pitcher_profile`, `missing_handedness_splits`,
`capped_by_data_quality`, `stale_game_state`, `stale_statcast`, `no_recent_batted_ball_events`,
`below_threshold_with_full_data`, `below_threshold_with_degraded_data`. Critically, S2/S4 must emit
`below_threshold_with_degraded_data` (or `capped_by_data_quality`) instead of "below threshold"
whenever any upstream input that fed the probability was absent.

---

## 5. Is the live HR Radar copying the manual workflow correctly?

| Manual workflow element | Implemented? | Where / gap |
|---|---|---|
| Hitter power profile | ✅ | `computePowerProfile`, season HR/barrel/xISO — **but neutralized to league avg when both season HR & barrel missing (Flag D)** |
| Recent hard contact | ⚠️ | present via contact classes, **but Flag A drops events with any missing Statcast field** |
| Barrel / EV / LA | ✅/⚠️ | canonical barrel shared engine↔UI; **`HRSignalBuilder` null→0 vs `nearHrContact` null-preserve disagree** |
| Pitcher vulnerability | ✅ | `computePitcherMultiplier`, handedness ERA — neutral on missing splits ✅ |
| Handedness matchup | ⚠️ | neutral-on-missing ✅ **but switch hitters (`"S"`) mis-bucketed into RHB split (R-2); roster-miss nulls all hands (R-1)** |
| Pitch mix / batter strength | ✅ | `pitchMixHandedness` multiplier, presence-guarded ✅ |
| Park / weather / context | ✅ | env multiplier; **`windDirection="cross"` default conflation (P-3)** |
| Batting order / expected PA | ✅ | `computeRemainingPA`, lineup Θ — **defaulted slot can hard-veto (Flag E)** |
| Live game state / inning / PA | ⚠️ | **AB-granularity only (see §7) — no pitch-level / in-progress-AB reaction** |
| Recent in-game swing quality | ⚠️ | EV-acceleration / repeated-danger exist (`nearHrContact`) but only re-evaluated on completed-AB ticks |
| Building-toward vs in-window | ✅ | watch→build→ready→fire FSM models this well |
| Alerts fast enough after events | ❌ | **structurally late (see §7)** |

**Where the implementation diverges from the manual feel:**
- **Overweights nothing egregiously**, but **underweights live batted-ball confirmation** by only
  acting at AB completion and behind a 6–27s cadence.
- **Waits too long to promote**: the `consecutivePromoteTicks` sustained-conviction gate
  (`liveGameOrchestrator.ts:4593-4594`) + one-rank-per-cycle promotion
  (`hrRadarStateMachine.ts:281-283`) mean a hot batter cannot reach FIRE within a single AB.
- **Proxy mismatch:** AVG/SLG substituted for xBA/xSLG (D-2); `barrel=0` proxying "no barrels" vs
  "barrel unknown" (Flag B).

---

## 6. Are we sorting/displaying the wrong score?

**Six distinct score concepts** exist (current readiness, peak readiness, hero/headline,
HR-chance probability, banded actionability, synthetic stage floors), computed across **three
parallel systems** (storage ladder, `hrRadarStateMachine` FSM, `hrRadarSection`) that emit
**different numbers and section names for the same card**.

Findings:
- **Within-section sort is CORRECT** — by current readiness, not peak (`storage.ts:6431-6440`). The
  old "backwards" peak-sort bug is fixed here. ✅
- **HR-chance higher in a lower tier is intentional** (uncapped true prob;
  `displayWhyNotTopWindow` copy reconciles it). ✅
- 🟠 **`displayReadinessScore10` is raw + un-banded** (`hrRadarDisplayContract.ts:220`). Only
  `displayActionScore10` was made tier-monotonic. If the card leads with raw readiness (as it
  historically did), a WATCHING card can show a higher headline /10 than a TOP WINDOW card — the
  exact inversion the contract was built to kill, only half-closed.
- 🟠 **Peak readiness never decays and is emitted on the wire with no freshness guard**
  (`hrRadarCanonicalStore.ts:160-166`, `storage.ts:6333`). Any serializer/client that renders
  `peakSignalScore10`/`displayPeakScore10` shows a dead candidate looking alive.
- 🟠 **Legacy section placement falls back to peak when current is null** (`storage.ts:5995`:
  `currentReadinessScore ?? peakReadinessScore`) — placement axis silently uses stale peak.
- 🟡 **Synthetic stage floors** (`fallbackScoreForStage`, `STAGE_SCORE_FLOOR`) can inflate a
  0-readiness card to 5.5/7.5 for display.

Frontend (additional, contract-relevant):
- 🔴 **Share-card hero numbers are client-derived** and POSTed to the render endpoint
  (`HrRadarLadder.tsx:775-796` → `routes.ts:4074`) — a shareable artifact can show a number the
  server never stamped.
- 🔴 **0-AB live rows are re-bucketed off their server section** into a collapsed client-only "NO AB
  YET" lot (`HrRadarLadder.tsx:1646-1695`) — a server FIRE/READY candidate disappears from the
  headline section by a client predicate.
- 🟠 **Breakdown bars / quick-decide chips render uncapped raw readiness/build/HR%** alongside the
  banded hero (`HrRadarLadder.tsx:597-604`, `HrQuickDecide.tsx:83-91`) — re-introduces the
  backwards look.
- 🟠 **No per-row engine freshness on the ladder** (the other route stamps `dataFreshnessMs` /
  `lastRecomputeAt` but the ladder drops them) — a stale row looks as live as a fresh one.
- 🟡 Dead code `mapHrRadarCardToUi` re-derives tier/state client-side (unused; delete to prevent reuse).

---

## 7. Are alerts late?

**Yes — this is the single biggest reason the engine underperforms the manual workflow.**

Latency chain (worst case, a live game with no active signal yet):
- **Poll cadence:** live game with no active signal in innings 2/4/6/≥8 polls every **12s**
  (`oddsConfig.ts:40-58`, `oddsScheduler.ts:47-52`); only odd innings 1/3/5/7 or already-signaled
  games get 6s.
- **Detection granularity:** fires only on a **new completed AB** (`dataPullService.ts:909-928` →
  `liveGameOrchestrator.ts:1733-1735`). No pitch-level or in-progress-AB reaction.
- **Engine dedup:** `ball_in_play`/`hard_hit_event` are **not** in `HIGH_IMPACT_TRIGGERS`
  (`liveGameOrchestrator.ts:1145-1148`), so a contact event without an AB-boundary trigger waits
  the full **15s** dedup (`:2007-2015`).
- **Promotion gate:** `consecutivePromoteTicks` sustained-conviction + one-rank-per-cycle
  (`:4593-4594`, `hrRadarStateMachine.ts:281-283`) ⇒ FIRE needs **N polls**, not one AB.
- **Net worst case ≈ 12s poll + 15s dedup ≈ 27s** to react, then several more cycles to reach FIRE.

**Can promotion happen after the HR? Yes, by construction.** Per poll, `gradeHomeRunsFromPlays`
runs **before** re-scoring (`liveGameOrchestrator.ts:1731` before `:1734`/`:1901`), and the HR play
+ its batted ball arrive in the **same** `syncContactData` call. For a batter whose prior ABs never
crossed threshold, **the first observation is the HR itself** → straight to `model_review` /
`uncalled_hr` (`hrRadarStateMachine.ts:306-325`). The `late_signal` / "uncalled HR" buckets are the
system's own admission that pre-HR promotion routinely arrives too late.

**Cooldowns that can swallow a fast candidate:** 10-min per-player `evaluateHRAlert` cooldown
(`evaluateHRAlert.ts:144,455-464`) blocks re-escalation after an early low-tier signal; 5-min bus
dedupe by `signalId+state` (`alertSubscriber.ts:73,129-138`).

**Freshness logic is NOT the culprit** — it flags/degrades rather than hides; thresholds are
generous (odds staleMs 180s, engine heartbeat 25s).

---

## 8. Are outcomes evaluated correctly? (confusion model)

**Attribution key:** one alert row per `(sessionDate, gameId, playerId)` (`schema.ts:669`); a
qualifying signal *event* must have `detectedAt < hrEnd` (`storage.ts:3447-3457`). Same-PA HRs are
handled correctly via a 2s `TICK_TOLERANCE_MS` → `late_signal` (not a false miss).

**The credit gate is fire-tier-only** (`reachedHrMaxWindow`, `hrRadarSection.ts:183-186`). Net:
- **HR after FIRE/actionable** → `called_hit` (counted win).
- **HR after only WATCH/BUILD seen** → `uncalled_hr` / diagnostic — **neither win nor counted miss
  (no "hidden true positive" credit class exists).**
- **No-HR while sub-actionable** → `expired`/`unresolved` (excluded from misses).

**Two attribution flaws that make the engine look worse than it is:**
1. 🔴 **Decayed-but-correct fire loses its win unless a synthetic-event patch lands.** The DB matcher
   uses **current-tier** `reachedHrMaxWindow` only (`storage.ts:4264`). Peak credit
   (`reachedHrMaxWindowPeak`) is retrofitted **only** by an orchestrator-side synthetic qualifying
   event (`liveGameOrchestrator.ts:569-651`, "Fix A"), whose write **swallows errors**. If that
   write fails or reconcile runs without it, a genuine fire that cooled before the HR records as
   `uncalled_hr`.
2. 🟠 **Reconcile fallback fails real pre-HR signals lacking `signalInning`** (`storage.ts:4791`)
   and **`hr_outcomes` keys on `batterName`/`batterMlbId` while radar keys on `playerId`** — a join
   miss surfaces a real call as an "uncalled HR" purely from identity mismatch.

**Confusion table — definitions to use (the engine must be judged on "HR after the candidate was
*actionably surfaced*", not "HR after any signal"):**

| Class | Definition | Current system label |
|---|---|---|
| True positive | FIRE/actionable before HR | `called_hit` ✅ |
| Late positive | promoted after HR / same-tick | `late_signal` (admin-only) |
| Hidden true positive | seen (watch/build, score ≥ floor) but not promoted, then HR | `uncalled_hr` / `live_promotion_miss` (diagnostic only) — **no ledger credit** |
| False positive | alerted, no HR | `called_miss` (counted) |
| True negative | no meaningful signal, no HR | not recorded |
| False negative | strong inputs, no signal before HR | not distinguished from true negative |

The table **cannot be populated with real counts in this container** (no DB). §9 gives the runnable
harness to populate it from production.

---

## 9. Local diagnostic / backtest harness

**There is no DB-backed HR-Radar backtest today.** `backtestHarness.ts` is a **prop-edge** harness
(in-memory cases, no DB, no radar logic). But the **raw material exists** to build one, and all
grading functions are pure/DB-free (`decideHrRadarMatch`, `reachedHrMaxWindow`,
`reachedHrMaxWindowPeak`, `classifyHrReview`).

**Per-HR reconstruction is possible from `hr_radar_signal_events`** (append-only: `score`,
`signalState`, `eventType`, `inning/half`, `detectedAt`, drivers) joined to `hr_outcomes`. For each
recent HR you can produce: player, game, HR inning/time, first-seen time (earliest event), highest
section reached (max `signalState` across events), score before HR (last `score` with
`detectedAt < hrEnd`), and whether it was promoted/suppressed.

**Two gaps to close for a faithful replay:**
- `hr_outcomes` (name/`batterMlbId`) ↔ radar (`playerId`) **identity bridge** required.
- **Suppression reasons / missing-inputs are not persisted** (in-memory `qualificationAudit` only),
  so "why not promoted" cannot be reconstructed after a restart. → persisting the reason taxonomy
  (§4) is a prerequisite for a *complete* retrospective.

**Proposed harness (read-only, runnable against production DB):** `scripts/backtestHrRadar.ts`
```
for each hr in hr_outcomes where game_date in [window]:
  events = hr_radar_signal_events where (gameId,playerId)=resolve(hr) order by detectedAt
  firstSeen   = events[0]?.detectedAt
  preHrEvents = events.filter(e => e.detectedAt < hr.endTimeMs)
  peakStage   = max(preHrEvents.map(signalState))
  scoreBeforeHr = last(preHrEvents).score
  classify into the §8 confusion table using reachedHrMaxWindow / reachedHrMaxWindowPeak
emit per-HR rows + confusion totals + (denominator = count of HRs by rostered batters in tracked games)
```
This is the **verified denominator** the philosophy section demands; do not quote a hit rate
without it.

---

## 10. Ablation report

**Cannot be executed here** (no DB/keys). The harness above is the vehicle. Recommended arms to run
once it exists, holding the recent-HR sample fixed:

| Arm | Change | Hypothesis |
|---|---|---|
| A. Current production | baseline | establishes the real denominator + confusion table |
| B. No missing-data hard caps; confidence penalty only | Flag A null→0 → null-skip; Flag B `0`→treat as unknown; S2/S4 emit degraded reason instead of suppress | recovers hidden true positives; isolates how many "misses" are data artifacts |
| C. Fixed split/profile data | repair D-4/P-2 negative caching + R-1 roster + R-2 switch-hitter | isolates feed-quality contribution |
| D. Manual-workflow-aligned scoring | weight live batted-ball confirmation up, pregame static down; pitch-level reaction | tests workflow drift hypothesis |
| E. Section placement by current actionability, not peak | already mostly true for sort; close §6 peak fallbacks + un-banded readiness + client re-bucketing | isolates display-driven "looks bad" |

Expected ordering of impact from the static analysis: **A→B** (largest, recovers hidden positives),
then **D** (timing/workflow), then **C** (feed), then **E** (display).

---

## Deliverable 4 — Recommendation

**Do NOT approve the current engine as-is, and do NOT rewrite scoring.** The scoring math is sound;
the failures are (in priority order):

1. **Fix outcome attribution first** (cheapest, highest truth-value): make the DB matcher itself
   peak-aware (call `reachedHrMaxWindowPeak` in `storage.ts:4264`, not only via the fragile
   synthetic-event patch); add the `live_promotion_miss` / "hidden true positive" as a *reported*
   class; fix the `signalInning`-null reconcile gap and the name↔id join. **This changes how the
   engine is *scored*, not how it *bets* — safe to do before any scoring work.**
2. **Fix the data layer** (safe, behavior-preserving for true data, behavior-correcting for
   transient empties): copy the per-game-feed defensive pattern to the season fetch (D-4) and split
   fetch (P-2) so transient empties don't poison cache; add a roster-freshness/`available` signal
   (R-1); resolve switch-hitter effective side (R-2). These are the "clear data-fetch" class.
3. **Replace missing-data hard behavior with confidence penalties** — specifically Flag A
   (`HRSignalBuilder` null→0 → null-skip like `nearHrContact`) and Flag B (`barrel=0` vs unknown),
   and make S2/S4 emit a `degraded_data` reason instead of a "below threshold" lie. This is a
   *behavior* change → gate behind the ablation + regression suites + goldmaster re-baseline.
4. **Adjust alert timing** — promote `hard_hit_event`/`ball_in_play` into `HIGH_IMPACT_TRIGGERS`,
   raise live-no-signal cadence from 12s toward 6s, and let a single elite barrel reach READY
   without the full `consecutivePromoteTicks` dwell. Behavior change → ablate first.
5. **Adjust section/display** — band `displayReadinessScore10`, add a freshness/decay guard to peak
   on the wire, stop client re-bucketing 0-AB FIRE/READY rows, and make the share card read
   server-stamped fields. Display-only → low risk.

**Sequence:** (1) and (2) and the display fixes in #5 are safe to ship now; (3) and (4) require the
ablation harness + regression suites + goldmaster bump per CLAUDE.md §7a before shipping.

## Deliverable 5 — Exact patch plan (no scoring changes applied yet)

**Phase 0 — instrumentation (no behavior change):**
- Add a persisted `suppressionReason` enum (taxonomy in §4) to `hr_radar_signal_events` (or the
  alerts row) and stamp it at every suppression site (S1–S12, N1–N3, Flag A). Migration only.
- Build `scripts/backtestHrRadar.ts` (§9) + the name↔id bridge.

**Phase 1 — safe correctness (ship after review):**
- `storage.ts:4264` — OR-in `reachedHrMaxWindowPeak` directly in the matcher.
- `storage.ts:4791` — allow inning-null pre-HR signals to pass via timestamp when `hrEndTimeMs` known.
- `dataSources.ts` season fetch + `dataPullService.ts` split fetch — adopt the
  `fetchSavantGameFeed` pattern: never overwrite good cache with an empty result; don't cache
  all-null on a transient empty.
- `rosterService.ts` — add `lastSyncedAt` / `available`; consumers check it before treating
  `bats===null` as resolved.
- `hrConversionModel.ts:520` + new effective-side resolver — handle switch hitters.

**Phase 2 — behavior change (gated on ablation + regression + goldmaster bump):**
- `HRSignalBuilder.ts:180-182` — stop `?? 0`; skip-null like `nearHrContact`, emit
  `missing_statcast`.
- `subEngines.ts:211-217` — distinguish `barrel===0` (treat as unknown) from genuine low barrel.
- `evaluateHRAlert.ts:487,1425` — emit `below_threshold_with_degraded_data` when any contributing
  input was absent.
- Timing: `liveGameOrchestrator.ts:1145-1148` add batted-ball triggers; cadence + sustained-conviction tuning.

**Phase 3 — display:**
- Band `displayReadinessScore10`; peak freshness guard; remove client 0-AB re-bucketing
  (`HrRadarLadder.tsx:1646-1695`); share card reads server fields; delete dead `mapHrRadarCardToUi`.

**Guardrails for every phase:** run the §1 regression suites in CLAUDE.md; expect/΄accept
`[MLB_DRIFT_WARNING]` only after a deliberate `MLB_GOLDMASTER_VERSION` bump; never lower thresholds
or inflate scores to chase a hit rate; missing data reduces confidence (degraded state), only
*fatal* missing data blocks a signal.
