# Plan (Rev. 4.2 · PR4.3.3 amendment) — Two Production Upgrades to "The Plate" Pregame HR Engine

> **PR4.3.3 amendment (training-read integrity + provenance matrix + payload validation + strict-ISO timestamps — landed).** §7.1 declares the full snapshot contracts: `SourceEvidenceSnapshot` gains `authorizedPayload`/`provenanceIncomplete` with nullable `availableAt`/`fetchedAt` and a canonical-**object** `sourceSnapshotId` that content-addresses ALL provenance (so provenance can't drift without changing identity); `PredictionSnapshot` gains `firstPitchTime`/`trainingEligible`/`authoritative`/`trainingBlockReasons[]` and a `contentHash` over the COMPLETE immutable envelope. Authoritative selection happens at training-read time (deterministic latest-≤-first-pitch); the single strict gateway `evaluateTrainingReadIntegrity` takes no weakening options, runtime-parses untrusted DTOs (never throws), enforces the full provenance matrix (per-`availabilitySource` timestamp law; `reconstructed` derived from `fetchedAt`; reconstructed admitted only for the verified-as-of class), and validates typed, semantically-non-empty, count-monotonic payloads. §5a/§8.1/§8.2/§11 corrected: the stored damage statistics are `xslgContactSum/xslgContactN` + `xwobaContactSum/xwobaContactN` (each over its own count; xwOBA-on-contact is a run-value, NOT `P(HR|BBE)` and not an HR-probability stat); no summed-HR-damage field exists. Body below is otherwise Rev. 4.2.
>
> Planning/research output only. **Rev. 4.2** is a consistency patch over Rev. 4: (1) complete `SourceEvidenceSnapshot` fields (`availableAt`/`availabilitySource`/`reconstructed`/`evidenceKind`/`validForAt`) + composite prediction uniqueness; (2) source-specific point-in-time rules by `evidenceKind` (historical vs lineup/probable vs weather-forecast vs reconstructed); (3) `power_iso` = **display-layer suppression only** (qualification byte-identical, since it's a counted JUL20 driver); (4) zone estimand states the measurable-BBE representativeness assumption + quality-coverage gate + shrunk `Ê`; (5) Test-set protection — selection on Calibration only, Test opened once, failure rejects (never re-tunes); (6) one internally-consistent bootstrap (paired slate-day cluster) + sealed signed `plateHrV2GateSpec` files in PR8. Architecture, math core, champion isolation, authority fallback, optional-evidence behavior, and rollback are unchanged. PR0–PR5.2 (through the read-integrity/provenance/strict-ISO hardening and the stabilized recent-contact-form shadow features + their versioning/evidence/gateway-enforcement corrections below) have landed on `claude/plate-hr-engine-upgrades-ispzmm`; PR6 is next.
>
> **Frozen champion baseline:** `8c818ec092ad803f57652be4521ae34f26321ae0` — the reference for every "confirmed from code" claim and the champion rollback target; recorded in all model/feature artifacts.
> **Current implementation head:** `7456970` (PR0–PR5.2 landed on `claude/plate-hr-engine-upgrades-ispzmm`, PR #151). **PR6** (corrected starter/bullpen joint PA-path probability, Deps: PR5) is next. PR5.1 suites (recentContactForm 37 + contract 45 + full V2), champion lock (78/78), shadow isolation (77/77), migration tests, and typecheck are green. This plan is committed at `docs/plate/plateHrV2UpgradePlan.md` as the canonical, verifiable implementation authority. **Note:** the branch has since been merged with `main`; PR0's display-layer Elite-ISO suppression was **superseded** by PR #152's canonical true-ISO gate (a different, now-authoritative implementation of the same intent) — PR5.1 was rebased onto that merge with the champion (78/78) and new slate-invariance (39/39) locks green.

---

## Context

**Why this work exists.** "The Plate" (LiveLocks → MLB → Pre-Game Power/HR engine) surfaces a **descriptive 0–10 composite**, not a home-run probability. It **ignores exact pitch-type matchup** (`matchup.batterXslgVsDominantFamily` hardcoded `null`, `buildPregamePowerRadar.ts:1061`) and its `power_iso` tag ("Elite Isolated Power") fires on nearly every surfaced player.

**Intended outcome.** Two mathematically distinct upgrades — (1) exact pitch-mix damage & pitcher vulnerability, (2) joint pitch-and-zone compatibility + a stabilized recent-contact-form layer — moving a **calibrated HR/PA→game-HR probability** (not tags/badges), plus selective server-authored evidence tags and the smallest legible UI/API change.

**Locked decisions:** promote calibrated probability to authority **only after out-of-sample validation** (staged, single flag); **spike-first** on zone data & provider feasibility; **true per-pitch-type** with hierarchical pooling. **Refine the existing shadow stack — do not build a second engine.** **Tags explain probability; they never create qualification.** **Odds are display/benchmark only** — never in probability, grade, qualification, or default ranking. **Never surface uncalibrated/default-prior coefficients as a probability.**

**Isolation guarantee.** All work in `server/mlb/pregamePowerRadar/**` (+ its tables, route, card). No change to MLB Live Edge, The Mound, retired HR Radar, NBA/NFL, or shared cross-sport scoring.

---

## 1. Executive verdict

A near-complete shadow stack exists and is inert: `math/*` (additive log-odds per-PA → game prob via PA distribution → identity calibration → shadow tiers; coefficients are **default priors, not fitted**) and `hrProbabilityV2/*` (forward-capture + walk-forward fit + Platt/isotonic calibrator + model registry + leakage guards; flag-gated). This is a **wire-refine-calibrate-promote** effort.

**Rev. 3 corrections (the eight blockers):**
1. **Immutable snapshots** → two append-only layers: `SourceEvidenceSnapshot` + `PredictionSnapshot` with a unique `predictionAsOf`; late changes create *new* prediction snapshots (never mutate).
2. **Point-in-time integrity** → store both `fetchedAt` and `dataThroughAt`; training may use only data available before `predictionAsOf`.
3. **PR order** → define the minimum v2 contract + persistence **before** enabling capture (capture flips on atomically once the contract exists).
4. **Elite-ISO timing** → **suppress `power_iso` only** (no relabel, no substitute artifact, no invented threshold); real activation deferred to the calibrated release (PR11). Suppression is at the **display layer** so champion `positiveDriverCount`/qualification stay byte-identical (see PR0 — `power_iso` is a counted JUL20 driver, `plateDriverUniverse.ts:39`).
5. **Exact-pitch estimand** → replace `isoSum`/generic `D̂/V̂` with explicit sufficient statistics; declare each outcome's grain (per pitch / per contact / per BBE / per terminal PA). ISO is never summed across pitch rows.
6. **Zone model** → contact-aware, separately-fitted batter and pitcher within-pitch deviations (`m`, `δ`, real exposure `π^P`); low-contact hot zones cannot look favorable.
7. **Optional-data qualification** → separate **required core** evidence from **optional matchup** evidence; missing optional data reverts to prior/neutral, lowers confidence, blocks its tag, and **never auto-disqualifies**.
8. **Shadow isolation & gates** → PR9 builds a **versioned challenger publication policy without touching the champion path**; the production switch happens only at PR11; public DTO never carries uncalibrated probability; all acceptance thresholds are **pre-registered** (not "set later"); tag issuance is **never volume-targeted**.

**Recommendation:** proceed with the revised order (§23). Two hard gates precede any public probability: the **data-feasibility go/no-go** (§6) and the **pre-registered numeric acceptance gates** (§22), the Test set opened once.

---

## 2. Current production architecture trace
*(Verified against `8c818ec`.)*

```
Baseball Savant per-pitch CSV (season, batter+pitcher) ─┐
MLB Stats API (rosters/lineups/probables/hand splits)   ├─ ingestion
Open-Meteo (weather) · park factors/dimensions          ┘
   fetchBaseballSavantData(:513) · fetchPitcher/BatterHandednessSplits(:491/:499)
      ▼ identity = MLBAM id string (rosterService.ts)
   candidate = EVERY batter in EVERY posted lineup (:458)
      ▼ 6 scorers: batterPower(0.28)·pitcherVuln⊕orderSplit(0.23)·matchupFit(0.18)
        ·parkWeather(0.14)·lineupOpp(0.09)·nearHrRecentForm(0.08)
   freezePlateInput()+hash(:1112) → evaluatePlateModel(frozen, PLATE_CHAMPION_POLICY)(:1129)
      ▼ composePregameScore → coverage caps(3.9/5.9) → matchupPenalty(≤2.5) → score10
      ▼ classifyTier(gated) → positiveDriverCount≥2 → decidePlatePublication
   DB pregame_power_radar_signals → buildResponse(diagnostics.ts) → GET /api/mlb/pregame-power-radar
      ▼ PregamePowerRadar.tsx (card renders score10/tier/drivers/gradeFactorSummary)
   grading shadowOutcomes.ts (HR immediate; miss requires final) → winAttribution.ts
```
**Inert beside it:** `math/*` and `hrProbabilityV2/*` (flag-gated). **UI:** card consumes `PregamePowerSignal` directly; hub envelope ignored.

---

## 3. Exact files & functions
*(Line refs against `8c818ec`.)* Production: `buildPregamePowerRadar.ts` (candidate `:458`; Savant `:513`; **pitch-type null** `:1061`; champion `:1129`; V2 shadow assembly `:1269-1302`); `scoring.ts` (`COMPONENT_WEIGHTS:152`, `composePregameScore:185`, caps `:203-223`, `matchupPenalty:235-258`, `classifyTier:118`); `batterPowerProfile.ts` (**`power_iso` cut `sIso≥6.5`** `:117`); `pitcherVulnerability.ts` (`:76-120`, `effectiveBatterSide:40`); `matchupFit.ts` (dead `sFamily:65`); `pitchFamilyMatchup.ts` (no denominator `:34-37`); `nearHrRecentForm.ts`; `{parkWeatherScore,parkDimensions,playerParkWindFit,lineupOpportunity,batterOrderSplit,pitcherOrderSplit,marketTagger,attackEnvironment,evidenceFamilies}.ts`; `modelVersions/{plateChampionJul20,plateChallengerCurrent,plateDriverUniverse,platePublicationDecision,plateShadowFlags,plateModelTypes}.ts`; `frozenPlateInput.ts`,`evaluatePlateModel.ts`,`diagnostics.ts(buildResponse:134)`,`shadowOutcomes.ts`,`winAttribution.ts`,`calibrationStats.ts`,`statsService.ts`,`statsRoutes.ts`,`gradedStateCarry.ts`,`pregamePersistence.ts`,`types.ts(PregamePowerSignal:363,Diagnostics:149)`. Shadow: `math/*`, `hrProbabilityV2/*` (see Rev. 2 list). Data: `dataSources.ts` (parse `:466-620`; pitch-mix bucket `:778-804`; batter splits `:217-269`; park `:302-382`), `dataPullService.ts`, `rosterService.ts`, `pitchTypeNormalizer.ts`, `shared/schema.ts` (`pregame_power_radar_signals:1001`; `plate_hr_v2_*:1458-1640`; `contact_events:528`). Client: `PregamePowerRadar.tsx`, `client/src/lib/mlb/{setupGrade,plateTagPresentation}.ts`, `{PregameHub,PregameWinCard,PregameHistoryDrawer}.tsx`, `admin/PregameRadarCalibrationCard.tsx`.

---

## 4. Confirmed root gaps
1. Production ignores pitch-type (`:1061`); `matchupFit.sFamily` dead. 2. 3-family ingestion; per-code counts discarded. 3. Batter pitch splits lack denominator. 4. Pitcher vulnerability handedness-only. 5. No pitch-location data; `zone` unverified. 6. No BBE-count contact windows. 7. No pregame projected-PA / starter-bullpen split. 8. Probability uncalibrated & unwired (default priors). 9. Elite-ISO cut too low+raw+funnel-amplified. 10. Client-duplicated grade + BvP banding. 11. Qualification depends on `positiveDriverCount≥2` (must be removed). 12. Market can influence surfacing order (must be excluded).

---

## 5. Row-level input audit (per-metric)

**Effect** = moves Probability(shadow)/Grade(score10)/Tag/Display. All Savant metrics derive from the already-fetched season CSV.

| Metric | Source field & type | Denominator (grain) | Current consumer | Effect | Shrinkage | Missing/stale | Dup risk | Coverage / licensing |
|---|---|---|---|---|---|---|---|---|
| xSLG | `estimated_slg_using_speedangle` num | BBE (per contact) | batterPower w2; shadow | Grade+prob | champ none/chal PA/shadow 120PA | null→neutral,4h | high | full; **lic TBD** |
| ISO / xISO | `xSLG−xBA` derived | PA/BBE (terminal PA) | batterPower w3; **power_iso** | Grade+**Tag** | none(champ) | parts null→null | high | full; lic TBD |
| Barrels/BBE | proxy `EV≥98 & LA20–35` | BBE (per contact) | batterPower w3 | Grade+Tag | none | null→neutral | high | proxy; **true barrel field=go/no-go** |
| Barrels/PA | not computed | PA (terminal PA) | — | none | — | — | — | derivable if barrel licensed |
| Avg EV | `launch_speed` mean | BBE (per contact) | batterPower w1 | Grade+prob | none | null→neutral | high | full |
| EV90 (P90 EV) | percentile of `launch_speed` — not computed | BBE (per contact) | — | none | — | — | med | derivable from rows |
| Hard-hit% | `EV≥95` share | BBE (per contact) | batterPower w2 | Grade | none | null→neutral | high | full |
| Air-ball%/FB% | `bb_type`/`launch_angle` | BBE (per contact) | batterPower w1 | Grade | none | null→neutral | med | full |
| Sweet-spot% | `launch_angle∈8–32` | BBE (per contact) | batterPower w1 | Grade | none | null→neutral | med | full |
| xHR/contact | not computed (EV/LA model) | BBE (per contact) | — | none | — | — | high | derivable; **not** from `contact_events` (no xba) |
| Pulled-air contact% | overall `pullRatePercent` only | BBE (per contact) | shadow proxy | prob | min-sample | null→neutral | med | pull% full; pulled-air not isolated |
| Whiff% | `description` swings/misses | swings (per swing) | `batterPitchSplits.whiffPct` (**unused by score**) | Display | ≥10-swing | null→omit | low | full |
| Pitch count | rows by `pitch_type` int | — (per pitch) | pitchMixPct (3-family) | Display/shadow | — | family bucket | n/a | full |
| BBE count | batted-ball rows int | — (exposure) | `battedBallEvents` shrink denom | Grade(shrink) | IS denom | null→no shrink | n/a | full |
| PA count | `min_pa` grouping int | — (exposure) | `paSample` shadow shrink | prob | IS denom | null→weight0 | n/a | full |
| Bat speed | `bat_speed` num | competitive swings | shadow batTracking | prob | 40-swing K | null→no-op | med | **2023+ only; coverage=go/no-go** |

### 5a. Exact-pitch sufficient statistics (replaces ambiguous `isoSum`)
Persist, per exact pitch code × entity(batter/pitcher) × opponent-hand, **explicit sufficient statistics with declared grain** — never a pre-summed ISO:
```
pitchCount        (per pitch)     swingCount   (per pitch)     whiffCount (per swing)
contactCount      (per swing; INCLUDES foul contact)          bbeCount   (balls in play; exposure)
qualityBbeCount   (BBE with measurable EV/LA; the denominator for damage-on-contact)   ← Rev. 4
paEndedCount      (per terminal PA)  barrelCount (per qualityBBE)  hrCount (per terminal PA)
xslgContactSum / xslgContactN   (Σ estimated_slg over measurable BBE, with its OWN count N)   ← Rev. 4 / PR4.3
xwobaContactSum / xwobaContactN (Σ estimated_woba over measurable BBE, with its OWN count N — xwOBA-on-contact; this is NOT P(HR|BBE) and is NOT an "xHR quality")   ← PR4.3
[if ISO retained] terminalAtBats, terminalHits, terminalTotalBases (per terminal PA) → ISO derived downstream
```
Every modeled outcome declares its grain. **Damage-on-contact is measured over the BBE that carry measurable EV/LA, NOT `contactCount`** — `contactCount` includes foul contact for which EV/LA quality does not exist, so dividing a quality sum by it is invalid. Each damage sum carries **its own paired count** and is divided by that paired count, never by a different denominator: xSLG-on-contact = `xslgContactSum/xslgContactN`; xwOBA-on-contact = `xwobaContactSum/xwobaContactN`. `qualityBbeCount` counts BBE that cleared the EV+LA validity gate and is the denominator for the barrel PROXY rate = `barrelCount/qualityBbeCount`; whiff = `whiffCount/swingCount`; BBE probability = `bbeCount/pitchCount`. **No summed-HR-damage field exists** — a genuine HR-specific damage estimand would be a separate, explicitly-defined, separately-versioned EV/LA→HR proxy (§21), never a rename of xwOBA-on-contact. Nothing is summed across incompatible denominators.

---

## 6. Data-source feasibility — **formal go/no-go artifact (blocking)**

Before any production ingestion, produce `docs/plate/plateHrV2DataFeasibility.md` answering per source: commercial-use/licensing rights for a paid product; historical coverage (seasons; bat-speed 2023+, barrel field); update cadence vs 6am-ET build; endpoint/rate limits & bulk allowance (**no per-card calls**); cost at slate volume; field-level presence (`plate_x/plate_z/zone/sz_top/sz_bot`, barrel, bat_speed via the PR-spike). **Go/no-go rule:** a feature failing licensing/coverage/limits is not built into production; fall back to the closest statistically valid alternative (family-level, or forward-capture-only until coverage accrues) **labeled a proxy** — never disguised as exact pitch/zone modeling. Coverage thresholds are **frozen here, before the Test set**.

---

## 7. Data contracts, immutable snapshots & storage (Rev. 3)

### 7.1 Two-layer, append-only, point-in-time snapshots
Immutability means **append-only with unique keys**, not "rebuild in place." Two layers:

- **`SourceEvidenceSnapshot`** — one **immutable evidence version** of an entity's evidence: `(sourceSnapshotId, provider, entityId, entityType, evidenceKind, dataThroughAt, availableAt?, availabilitySource, validForAt?, reconstructed, provenanceIncomplete, fetchedAt?, schemaVersion, contentHash, payloadRef, authorizedPayload)`. `fetchedAt` = when we fetched; `dataThroughAt` = the latest game/date the underlying data actually covers; **`availableAt`** = the verified time the evidence could have been known; **`availabilitySource`** = how `availableAt` was established (`fetched_at` \| `provider_published_at` \| `provider_issued_at` \| `verified_as_of` \| **`unverified`**); **`reconstructed`** = true when fetched after the prediction moment; **`provenanceIncomplete`** (PR4.3) = true when the real fetch time / cutoff could NOT be established — then `fetchedAt`/`availableAt` are **honestly NULL** (never a substituted capture moment), `availabilitySource="unverified"`, and the source is **always training-INELIGIBLE**; **`evidenceKind`** ∈ {`historical_stat`,`lineup`,`probable`,`weather_forecast`,`park`}; **`validForAt?`** = the time the evidence describes (weather-forecast game time, legitimately future); **`authorizedPayload`** = the immutable, closed-allowlist-projected payload the row hashes over (top-level AND nested projection; NULLABLE — a null/empty payload is rejected at write, never manufactured as `{}`). **`sourceSnapshotId` = `plate-hr-v2-src:` + a canonical-OBJECT hash of the FULL descriptor** — provider/entity/kind/schemaVersion/contentHash **and every eligibility-critical provenance field** (`dataThroughAt`/`availableAt`/`fetchedAt`/`availabilitySource`/`validForAt`/`reconstructed`/`provenanceIncomplete`). So **identical canonical descriptors are idempotent (one row); any change to content OR provenance mints a distinct immutable version** — provenance can never drift without changing identity. The single `computeSourceSnapshotId()` is used at write AND training-read time (the reader recomputes and rejects a row filed under a mismatched key). Shared across every batter-game by id, **never duplicated** into each batter row.
- **`PredictionSnapshot`** — one row per (batter-game, moment): `(predictionSnapshotId, gamePk, batterId, featureVersion, predictionAsOf, firstPitchTime?, sourceSnapshotIds[], derivedFeatures, contentHash, trainingEligible, authoritative, trainingBlockReasons[])`, with a **composite uniqueness constraint `(gamePk, batterId, featureVersion, predictionAsOf)`**. **`contentHash` covers the COMPLETE immutable envelope** (PR4.3 #5): `gamePk`/`batterId`/`featureVersion`/`predictionAsOf`/`firstPitchTime` + `derivedFeatures` + sorted `sourceSnapshotIds` — so tampering with ANY immutable field is detected. Mutable lifecycle state (`authoritative`, `trainingEligible`, `trainingBlockReasons`) is **excluded from the hash** and verified separately. `trainingEligible`/`trainingBlockReasons` are the **write-time** decision (a cross-check); the reader recomputes. A **late lineup/probable/weather change creates a NEW PredictionSnapshot** (new `predictionAsOf`) referencing the then-current source snapshots — the prior one is retained, never mutated.

**Point-in-time integrity (Rev. 4.2) — rules are source-specific by `evidenceKind`.** A PredictionSnapshot is training/label-eligible only if **every** referenced `SourceEvidenceSnapshot` passes the rule for its kind:
```
historical_stat        : dataThroughAt < predictionAsOf ≤ firstPitch   # only games before the prediction
lineup | probable      : availableAt   ≤ predictionAsOf ≤ firstPitch   # knowable when predicted
weather_forecast       : availableAt(=issuedAt) ≤ predictionAsOf ; validForAt MAY be future game time
park                   : availableAt   ≤ predictionAsOf                 # static/seasonal
any reconstructed=true : eligible ONLY with verified reproducible as-of retrieval (PR2), else excluded
```
This prevents two symmetric errors: a valid pregame **weather forecast** (issued before the prediction but describing future game time) must **not** fail a `dataThroughAt<predictionAsOf` guard; and **observed post-game weather** (a forecast whose `availableAt` is after the prediction, or a stat with `dataThroughAt ≥ predictionAsOf`) must **not** leak into training. `availabilitySource` records how `availableAt` was verified. A record fetched *after* `predictionAsOf` is `reconstructed=true` and excluded unless the provider supports reproducible as-of retrieval. A `provenanceIncomplete=true` source (null `availableAt`) is excluded unconditionally.

**Authoritative-snapshot selection (PR4.3 #3) — established at TRAINING-READ time.** The writer cannot know which revision is the last before first pitch, so it always persists `authoritative=false`. Authority is assigned **deterministically at read time** by the single training gateway: within each `(gamePk, batterId, featureVersion)` group, among integrity-valid revisions with `predictionAsOf ≤ firstPitch`, the **latest `predictionAsOf`** wins (tie-broken by `predictionSnapshotId`); every other revision is rejected as `superseded_by_authoritative_revision`. This guarantees **exactly one training observation per batter-game** — multiple pregame revisions can never become duplicate rows. Records whose true cutoff cannot be established are excluded; live/after-lock changes are stored, non-authoritative.

**Strict training-read gateway (PR4.3 #4/#5).** `evaluateTrainingReadIntegrity(predictions[], sourceRows)` is the **only** admission path into training and takes **no options that could weaken a check**. It uses the single canonical hasher (`canonicalJson`/`canonicalHash`), which **throws on any value the serializer could silently collapse** (undefined, NaN, Infinity, function, bigint, symbol, non-plain object such as `Date`/`Map`). Per row it unconditionally recomputes: the prediction snapshot id; every source snapshot id (full descriptor); every source's point-in-time eligibility (never trusting cached `trainingEligible`); every `authorizedPayload` ↔ `contentHash`; and the complete prediction envelope hash — and requires a parseable first pitch, `predictionAsOf ≤ firstPitch`, and canonically sorted + unique source ids. Any failure ejects the row with reasons; only integrity-valid rows enter the authority selection above.

### 7.2 Feature sufficient stats & windows
- **Exact pitch-type** sufficient statistics per §5a (counts, not summed rates), batter & pitcher × opponent hand.
- **Zone** (PR-gated): raw normalized coordinates (`plate_x/plateWidth`, `(plate_z−sz_bot)/(sz_top−sz_bot)`) + coarse attack-zone aggregation × pitch × hand, with **separate** counters for all-pitches, competitive-pitches, swings, contact, and HR-quality-on-contact. Zone-bucket definitions versioned; coordinates outlive them.
- **Recent-contact-form**: EWMA over last 25–50 BBE (barrel%, avgEV, EV90, hardHit%, airBall%, sweetSpot%, pulledAirContact%, xwOBA-on-contact — a run-value; any EV/LA→HR proxy would be a separately-versioned feature, never a rename) + `effectiveBbe`, `last15Bbe`.
- **PA-path**: joint starter/bullpen structure (§10) + `starterWorkload{avgBF,avgIP,removalCurve}`, `bullpenExposure`, `platoonPinchHitRisk`.
- **Model registry** (`plate_hr_v2_model_registry`): fitted coefficients + selected calibrator + feature/version hashes + **baseline-composite calibration mapping** (§17) + **frozen tag/qualification thresholds & coverage gates** + baseline SHA `8c818ec`. `featureVersion → plate_hr_v2_features_v2`.

Migrations: idempotent self-healing `ADD COLUMN`/jsonb-key + a new `plate_hr_v2_source_evidence` / `plate_hr_v2_prediction_snapshots` pair (append-only); no destructive SQL; bootstrap-guarded.

### 7a. Operational edge cases
- **Openers/bulk pitchers** — starter segment shrinks (low `avgBF`/`avgIP`); PA mass shifts to `p_b`; matchup terms attach to whoever is projected to face the batter.
- **Late probable/lineup changes** — new PredictionSnapshot before first pitch (§7.1); after lock → carried-forward authoritative snapshot, flagged.
- **Switch hitters** — `effectiveBatterSide` selects side vs probable's hand; zone orientation follows the effective side.
- **Platoon/pinch-hit** — suppressor on `p` + PA-mass reduction when material.
- **Doubleheaders/game IDs** — key on `gamePk`; `sessionDateET` groups the slate.
- **Postponements** — snapshot `postponed`; excluded from labels; no calibration_miss.
- **Arsenal changes / usage horizon** — `u_p` recency-weighted over a defined horizon (last N starts); documented.
- **Cache/TTL/retry** — reuse 4h Savant / 24h splits / weather TTLs; aggregates derived at slate build & persisted; fetch failure → neutral contribution + lowered confidence + missing-reason, never fabricated.
- **Raw vs aggregate** — persist sufficient stats + normalized coordinates; not full per-pitch history in the hot path.

---

## 8. Exact mathematical model specification (Rev. 3)

Extend the additive log-odds core; **all β fitted out of sample** (§17); default-prior version is shadow-diagnostic only, never surfaced.
```
logit(p) = β0 + β_H·Hitter + β_F·RecentForm + β_E·ParkWeather
              + β_V·OppVulnerability + β_B·X_B + β_P·X_P + β_BZ·X_BZ + β_PZ·X_PZ + (suppressors)
```

### 8.1 Upgrade 1 — Exact pitch-mix (separately fitted, shrink once, explicit estimands)
```
u_p  = recency-weighted usage share of exact pitch p ; Σ_p u_p = 1 over the complete arsenal
D̂_p = hierarchically-shrunk-ONCE batter damage-on-contact estimand vs p (× pitcher hand)
V̂_p = hierarchically-shrunk-ONCE pitcher damage-allowed-on-contact estimand with p (× batter hand)
X_B  = Σ_p u_p · D̂_p        X_P = Σ_p u_p · V̂_p
logit(p) += β_B·X_B + β_P·X_P      # β_B,β_P FITTED (not 50/50, not fixed caps)
```
- **Estimands are explicit and grain-typed** (from §5a counts): damage-on-contact `D̂_p` is built from `xslgContactSum/xslgContactN` (and/or `xwobaContactSum/xwobaContactN`) — each a **per-measurable-BBE** quantity divided by **its own paired count**, never by `contactCount` (which includes fouls) and never by `qualityBbeCount` (a different denominator). **ISO is never summed across pitch rows** — if used, derived from terminal `atBats/hits/totalBases`. Terminal-PA outcomes (`hrCount/paEndedCount`), damage-on-contact outcomes (`xslgContactSum/xslgContactN`, `xwobaContactSum/xwobaContactN`), the barrel-proxy rate (`barrelCount/qualityBbeCount`), and exposure counts are kept distinct and never mixed. xwOBA-on-contact is a run-value quantity, **not** an HR probability.
- **Shrink once.** `D̂_p`,`V̂_p` are posterior means (§9); not re-multiplied by a shrink weight. Effective sample size drives uncertainty + tag eligibility only.
- **Complete arsenal / no cherry-pick** (`Σu_p=1`). **Fallback:** exact-type → family posterior → league/role prior. Missing split → prior (≈0 net signal).
- **Whiff/contact suppression is a SEPARATE fitted feature** (from `whiffCount/swingCount`, `contactCount/swingCount`) — HR opportunity is lowered by K-risk independently of damage-on-contact.
- **Additive main effects only.** No signed×signed. A batter×pitcher **interaction** is added only on proven independent holdout lift (§17).

### 8.2 Upgrade 2A — Contact-aware joint pitch×zone (Rev. 4: measurable-BBE estimand + frozen reference)
> **`q_dmg` is a design placeholder for a future, separately-versioned EV/LA→HR proxy — it is NOT any currently-stored field.** The measurable-BBE damage stats that exist today (`xslgContactSum/xslgContactN`, `xwobaContactSum/xwobaContactN`, §5a) are run-value quantities and must never be substituted for `q_dmg` or described as `P(HR|BBE)`. Until such a proxy is defined and versioned (§21), the zone term below is fit on an explicit run-value damage estimand (xSLG/xwOBA-on-contact), not an HR-probability estimand.
Per-pitch-zone HR-quality uses **measurable-BBE probability** (correctly folding in takes, whiffs, and foul contact — not an ambiguous "contact" probability), with batter & pitcher as **separate** within-pitch deviations, centered on a **frozen training-only reference location distribution** `ω^ref_{z|p,h}` (not the pitcher's own distribution, which would collapse the pitcher term toward zero):
```
m^B_{p,z} = P_B(BBE | p,z) · Ê_B(q_dmg | BBE, p,z)
   P_B(BBE|p,z)      = bbeCount_{p,z} / pitchCount_{p,z}      # measurable balls-in-play rate per pitch
   Ê_B(q_dmg|BBE,·)  = SHRUNK posterior mean of run-value damage-on-contact, estimated from qualityBbeCount_{p,z}
δ^B_{p,z} = m^B_{p,z} − Σ_{z'} ω^ref_{z'|p,h} · m^B_{p,z'}      # within-pitch deviation vs FROZEN reference dist.
# equivalent pitcher-allowed quantity:
m^P_{p,z} = P_P(BBE-allowed | p,z) · Ê_P(q_dmg allowed | BBE, p,z)
δ^P_{p,z} = m^P_{p,z} − Σ_{z'} ω^ref_{z'|p,h} · m^P_{p,z'}
π^P_{p,z} = u_p · P_P(z | p,h)                                  # real usage × pitcher's own location prob
X_BZ = Σ_{p,z} π^P_{p,z} · δ̂^B_{p,z}       X_PZ = Σ_{p,z} π^P_{p,z} · δ̂^P_{p,z}
logit(p) += β_BZ·X_BZ + β_PZ·X_PZ          # FITTED; all posterior components estimated WITHIN training folds, frozen for cal/test
```
- **Representativeness assumption (stated explicitly, coverage-gated):** the conditional mean `Ê(q_dmg|BBE,p,z)` is estimated only from `qualityBbeCount` (BBE with measurable EV/LA), yet multiplies `P(BBE|p,z)` computed over **all** `bbeCount`. This assumes quality-measured BBE are **representative** of all BBE in the cell. That is an assumption, not an identity — when `qualityBbeCount < bbeCount` the product is **not** an exact plug-in. Therefore `Ê` is a **shrunk posterior mean** (§9) and the cell is **eligible only above a frozen quality-coverage requirement** (`qualityBbeCount/bbeCount ≥ threshold`, frozen in the PR2 feasibility audit); below it the cell reverts to its pitch-mean/prior. The raw equality is never presented as exact.
- `P(BBE|p,z)` (measurable balls-in-play rate per pitch) means a **low-contact/high-whiff "hot" zone cannot look favorable** (its `m` is small). `π^P_{p,z}` (real usage × the pitcher's own location probability) requires the pitcher to actually locate there. `δ` centered on the **frozen reference** `ω^ref_{z|p,h}` prevents pitch/zone double-counting **and** keeps the pitcher term from self-centering to ≈0. Batter compatibility and pitcher damage-allowed remain **separate additive fitted terms**; `ω^ref`, `m̂`, `δ̂` estimated in training folds, frozen for cal/test.
- **Frozen zone decisions (before PR):** storage = normalized continuous coordinates; model basis = coarse attack zones first; vertical normalized by batter `sz_bot/sz_top`; horizontal by plate width; **orientation established with fixtures** on real rows; inside/outside applied **after** handedness; all-pitch tendency, competitive-pitch probability, swing/contact probability, and HR-quality-on-contact modeled **distinctly**. If the coordinate/coverage spike fails, 2A is deferred (no proxy labeled as zone modeling).

### 8.3 Upgrade 2B — Stabilized recent-contact form
```
adj = w·EWMA(25–50 BBE) + (1−w)·stabilizedBaseline(season posterior) ; w = reliability(effectiveBbe) [fitted, 15-BBE extra recency but capped]
X_form = latent(adj barrel, EV, EV90, hardHit, xwOBA-on-contact)     # single fitted latent over correlated features (run-value inputs; not an HR-prob input)
logit(p) += β_F·X_form      # applies to EVERY PA segment (§10)
```
Recent HR count / HR-FB cannot contribute; near-misses enter only via measured EV/LA/spray/xHR; missing bat speed tolerated.

**Score & odds:** post-promotion `score10` is a monotone map of calibrated probability; **odds excluded from probability, grade, qualification, and default ranking.**

---

## 9. Shrinkage, uncertainty & evidence classes (Rev. 3)

Three-level hierarchical shrinkage applied **once** to produce each posterior (`D̂_p`,`V̂_p`,`δ̂^B/P_{p,z}`): exact-cell → family/pitch-mean → league/role. Effective sample size drives (a) reported uncertainty, (b) evidence-confidence, (c) tag-eligibility floors — **never a second multiplier on the point estimate**.

**Evidence classes (drives qualification, §15/PR9):**
- **Required core evidence:** batter power skill + pitcher identity/handedness + confirmed lineup slot + park. Absence caps/suppresses as today.
- **Optional matchup evidence:** exact pitch-mix, zone, recent-contact-form, bat speed. Absence → **revert to trained prior / neutral contribution**, **lower confidence**, **emit a missing-data reason**, **block that evidence tag** — and **never auto-disqualify** an otherwise valid player.

---

## 10. HR/PA → game probability (joint expectation)
```
P(HR in game) = 1 − Σ_{n_s,n_b} P(N_s=n_s, N_b=n_b) · (1−p_s)^{n_s} · (1−p_b)^{n_b}
general: P(HR in game) = 1 − E[ Π_{j=1..N} (1 − p_j) ]
```
`N_s`,`N_b` jointly distributed (independence only if validation supports; else modeled via the starter-removal curve linking them). Per-segment decomposition keeps hitter/form/park in **every** PA; only opponent terms change:
```
logit(p_s) = β0 + Hitter + RecentForm + ParkWeather + StarterVulnerability + StarterPitchMix + StarterZone
logit(p_b) = β0 + Hitter + RecentForm + ParkWeather + ExpectedBullpenVulnerability
```
`p_b` integrates over the plausible reliever distribution. PA-path inputs: order-slot mean + starter workload/removal (opener-aware) + run environment; platoon/pinch-hit reduces PA mass when material. Property tests: monotone ↑ in `p_s`/`p_b` and total PA; starter-only terms never enter `p_b`; hitter/form/park always enter `p_b`; joint formula matches brute-force enumeration on small fixtures.

---

## 11. Double-counting prevention map
| Risk | Prevention |
|---|---|
| Pitch-type & zone from same pitches | Zone enters only as within-pitch deviation `δ_{p,z}` weighted by real exposure `π^P_{p,z}`; pitch-mean already counted (or training-fold-only residualization, params frozen for val/test — never full-sample). |
| Low-contact hot zone false edge | `m_{p,z}=P(BBE per pitch)·Ê(damage\|BBE)` (damage = run-value xSLG/xwOBA-on-contact, or a separately-versioned EV/LA→HR proxy — never a rename of a stored field) — few balls in play ⇒ small `m` ⇒ no edge (quality-coverage-gated). |
| Signed×signed false positive | Additive separately-fitted main effects (`β_B X_B+β_P X_P`, `β_BZ X_BZ+β_PZ X_PZ`); interaction only on holdout lift. |
| Correlated power stats | Fitted model allocates shared variance once; recent form is a latent, not a sum. |
| Pitch-mix vs true power | Matchup-conditional vs unconditional; refit ablation drops non-lifting terms. |
| Market vs model | Odds excluded from probability, grade, qualification, default ranking. |

---

## 12–13. Implementation plan & file map (Rev. 3 order)

Shadow/additive until the single authority release (PR11). Each: Obj · Files · Types · Migrations · Tests · Deps · Rollback · Accept.

**PR0 — Baseline record + row-level audit + Elite-ISO *display suppression*.** *Obj:* record SHA `8c818ec`; write §5/§5a audit (`docs/plate/plateInputAudit.md`); **stop the over-issuance now by SUPPRESSING the `power_iso` "Elite Isolated Power" tag from users** — no relabel, no invented threshold, no artifact substitution; real fitted threshold ships in PR11. **Suppression is at the display layer, NOT at emission.** Reason: `power_iso` is a counted JUL20 qualifying driver (`plateDriverUniverse.ts:39`, `countPositiveDrivers`), so removing its emission would change `positiveDriverCount` → qualification — which PR0 must not do. The `PowerDriver` object is still produced (so score/tier/qualification are byte-identical); it is filtered out of the **user-facing tag/driver list** (server `buildResponse` in `diagnostics.ts` and client `plateTagPresentation.ts`), and its qualification participation is unchanged. This is the **PR0-adjusted champion contract** (rollback target for PR11). *Files:* `docs/plate/*`; `diagnostics.ts` (drop `power_iso` from the surfaced drivers/tags), `client/src/lib/mlb/plateTagPresentation.ts` (remove from KEY_MAP/legend). **No change to `batterPowerProfile.ts` scoring, no qualification change, no other tag touched.** *Tests:* `power_iso` never surfaced to the client; `countPositiveDrivers` / champion `score10`/tier/publication byte-identical (isolation test asserting the internal driver still present and counted). *Deps:* none. *Rollback:* revert the display filter. *Accept:* §22 selectivity (Elite user-facing issuance = 0 until PR11); zero champion drift.

**PR1 — Minimum v2 contract + append-only persistence.** *Obj:* define `SourceEvidenceSnapshot` + `PredictionSnapshot` (§7.1) and the minimum `plate_hr_v2_features_v2` contract + persistence **before** any capture. *Files:* `plateHrV2FeatureContract.ts`, `frozenPlateHrV2Input.ts`, `shared/schema.ts` (+ append-only snapshot tables), new migrations. *Tests:* schema bootstrap idempotence; append-only guard; composite-uniqueness `(gamePk,batterId,featureVersion,predictionAsOf)`; **`evidenceKind`-specific eligibility guards** (historical `dataThroughAt<predictionAsOf`; lineup/probable `availableAt≤predictionAsOf`; weather-forecast `issuedAt≤predictionAsOf` with future `validForAt` **not** failed by any `dataThroughAt` rule; a valid pregame forecast passes, observed post-game weather fails); `reconstructed`-exclusion; as-of-completeness. *Deps:* none. *Rollback:* additive tables. *Accept:* contract + persistence round-trip.

**PR2 — Feasibility spikes → go/no-go + backfill decision (BEFORE capture).** *Obj:* verify Savant fields/licensing/commercial-use/coverage/cadence/limits/cost (§6) and **whether the provider supports reproducible as-of retrieval**; decide backfill reconstructability (§7.1). *Files:* read-only `hrProbabilityV2/scripts/auditSavantFields.ts`; `docs/plate/plateHrV2DataFeasibility.md`, `docs/plate/plateHrV2BackfillFeasibility.md`. *Rule:* if as-of inputs can't be faithfully reconstructed, **no backfill** — forward-capture only; a field failing licensing is **not** captured to production. *Deps:* PR1. *Rollback:* delete scripts. *Accept:* signed go/no-go; frozen coverage thresholds; explicit list of **authorized fields** for PR3.

**PR3 — Enable versioned forward capture (atomic; authorized fields only).** *Obj:* turn capture on **against the PR1 contract**, restricted to the **PR2-authorized fields/storage**, writing both source-evidence and prediction snapshots with `fetchedAt`/`availableAt`/`dataThroughAt`. *Files:* `plateHrV2CaptureFlags.ts`, `installPlateHrV2Capture.ts`, `plateHrV2ForwardCapture.ts`, `server/index.ts`. *Tests:* capture idempotence; no runtime mutation; **no per-card fetch**; late-change → new `predictionAsOf`; only authorized fields captured. *Deps:* PR1, PR2. *Rollback:* flag off. *Accept:* snapshots persist correctly; authoritative selection ≤ first pitch.

**PR4 — Exact-pitch sufficient statistics.** *Obj:* per §5a counts, batter & pitcher × hand. *Files:* `dataSources.ts` (retain per-code counts + grain-typed counters; hand split), `pitchTypeNormalizer.ts`, `plateHrV2SufficientStats.ts`, contract, `pitchFamilyMatchup.ts` (denominators), schema+migration. *Tests:* counts/denominator/hand/coverage; unknown code fallback; no summed ISO. *Deps:* PR2, PR3. *Rollback:* additive. *Accept:* counts persisted; coverage ≥ frozen threshold.

**PR4.2 — Sufficient-stat evidence hardening (review correction).** *Obj:* make the stored-evidence guarantees true end to end. *Files & fixes:*
- **Shared blank-safe number parser** `parseOptionalNumber.ts` (""/whitespace/"null" → null) used by **all three** aggregators: `dataSources.ts::aggregateBatterPitchAndContact` (the exact path that now feeds `bbeSample`/`whiffSwings`), `exactPitchStats.ts`, `plateHrV2SufficientStats.ts`. Regression test directly against `aggregateBatterPitchAndContact` (blank xSLG not counted, `xslgN`/`bbeSample` not inflated, blank `launch_speed_angle` not in `lsaClassifiedBIP`).
- **Missing provenance INVALIDATES the prediction** (not merely omits the source): evidence assembly returns blocking reasons; a historical payload present with no real `fetchedAtMs`/cutoff → `trainingEligible=false` (never substitute the capture moment). Update the normal eligible fixture to supply real provenance.
- **Validate stored evidence at write AND training-read:** `SourceEvidenceSnapshot`/`PredictionSnapshot` eligibility requires, per referenced source, `authorizedPayload != null` **and** `canonicalHash(authorizedPayload) === contentHash`. Builder **recomputes** `contentHash` from the payload; the PR1 `isPredictionSnapshotEligible` gains a resolver that re-hashes stored payloads so legacy/corrupted rows fail closed.
- **Closed, deep-cloned authorized payload:** `authorizedSufficientStatsPayload()` projects through an explicit **allowlist** of authorized sufficient-stat keys + authorized nested shapes (`pitchFamilyStats`, `pitchTypeExactStats` deep-projected), **deep-clones** to a canonical JSON value before hashing (nested mutation of the original can't change it).
- **Source id** = `provider + entityType + entityId + evidenceKind + dataThroughAt + schemaVersion + contentHash` (so identical content across different cutoffs/schema versions mints distinct immutable rows).
- **Migration (precise):** `authorized_payload` **drop `{}` default, drop `NOT NULL`**; convert any legacy `{}` → `NULL`; null/hash-invalid evidence excluded from training; every new write supplies a verified non-null payload.
- **Malformed-BBE guards in ALL THREE aggregators** via shared helpers — recognized `bb_type ∈ {ground_ball,line_drive,fly_ball,popup}`; valid `-90 ≤ LA ≤ 90`; valid `0 ≤ xwOBA ≤ 2.0`.
*Tests:* production-aggregator blank-cell regression; payload-without-provenance → prediction ineligible; cutoff/schema-sensitive source identity; deep payload immutability + unknown-field exclusion + write/read payload↔hash agreement; legacy `{}`→null ineligible. *Deps:* PR4.1. *Rollback:* additive/flag-gated. *Accept:* full V2 suite + champion lock + tsc.

**PR4.3 — Training-read integrity (review correction).** *Obj:* the write side is hardened (PR4.2); make the *read* side unconditionally verify integrity, and stop fabricating provenance. *Files & fixes:*
- **Honest provenance:** a provenance-incomplete historical source is written with **null** `fetchedAt`/`availableAt` (columns made nullable) + a persisted `provenanceIncomplete=true` flag + a blocking reason — never the substituted capture moment. Eligibility treats null `availableAt` / `provenanceIncomplete` as ineligible.
- **One exported `computeSourceSnapshotId(fields)`** used by BOTH the builder and the reader; the reader recomputes each source id from its stored fields (provider/entityType/entityId/evidenceKind/dataThroughAt/schemaVersion/contentHash) and rejects a row stored under a mismatched key.
- **Strict training-reader** `evaluateTrainingReadIntegrity(predictions[], sourceRows)` (new, unconditional, batch gateway) verifying per row: recomputed prediction id; no persisted blocking reasons; known first pitch + `predictionAsOf ≤ firstPitch`; unique **and canonically-sorted** `sourceSnapshotIds`; every id resolves; every source id recomputes from the full descriptor; every source passes point-in-time rules; every `authorizedPayload` is canonical and hashes to its `contentHash`; and the **prediction hash recomputes over the COMPLETE immutable envelope** (`gamePk/batterId/featureVersion/predictionAsOf/firstPitchTime + derivedFeatures + sorted sourceSnapshotIds`). It then deterministically selects one authoritative revision per batter-game.
- **Contract/schema:** add `authorizedPayload`/`provenanceIncomplete` to `SourceEvidenceSnapshot`; add `trainingEligible`/`authoritative`/`trainingBlockReasons` to the prediction contract + persist them; migration makes `fetched_at`/`available_at` nullable + adds `provenance_incomplete` + `training_block_reasons`.
- **Reject empty/missing authorized payload at write** (no `?? {}` manufacture) so the `{}`→NULL migration can never invalidate a new write; define **authorized nested schemas** for `pitchFamilyStats`/`pitchTypeExactStats` (closed nested projection, not just top-level).
*Tests:* provenance-incomplete → null timestamps + ineligible (no captured substitution); strict reader rejects each corruption (wrong stored id, mutated derivedFeatures/contentHash/sourceIds, missing/empty/hash-mismatched payload, missing first pitch regardless of options, duplicate ids); nested unknown fields excluded; empty-payload write rejected. *Deps:* PR4.2. *Rollback:* additive/flag-gated. *Accept:* full V2 suite + champion lock + tsc.

**PR4.3.1 — Training-read integrity hardening (review correction).** *Obj:* close four residual read-side gaps. *Files & fixes:*
- **`reconstructed` is derived from `fetchedAt`** (fetched after prediction), not `availableAt`. The reader independently verifies `reconstructed === (fetchedAt > predictionAsOf)`, rejects `provenanceIncomplete:false` with a null `fetchedAt`, and requires consistent `availabilitySource`/timestamp/`provenanceIncomplete` combinations (a published-before-but-fetched-after source is honestly `reconstructed:true` and excluded unless verified as-of).
- **No empty evidence enters training:** typed schemas for every authorized scalar + nested leaf; projection drops empty nested entries; a payload must carry ≥1 authorized numeric leaf; semantically-empty payloads (`{}`, `{pitchFamilyStats:{}}`, `{pitchFamilyStats:{fastball:{}}}`, `{evPercentiles:{}}`, `{pitchesSeen:{arbitrary:1}}`) are rejected at BOTH write and strict read (evidence-kind-aware — historical uses the closed sufficient-stats schema, weather/park/lineup use a genuine-non-empty check).
- **The gateway never throws on malformed persisted JSON:** untrusted DTOs are accepted as `unknown` and runtime-parsed (Zod) before any array/field access; a malformed row (`sourceSnapshotIds=null`, `trainingBlockReasons={}`, wrong types) becomes a deterministic rejection. Identity requires `map key === stored sourceSnapshotId === recomputed sourceSnapshotId`. Canonical serialization also rejects sparse arrays.
- **Complete-envelope prediction hash** (already in PR4.3) is retained; the source id is a canonical-**object** hash over the full provenance descriptor.
*Tests:* reconstructed-from-fetchedAt (inconsistent flag + fetched-after-excluded + missing-fetchedAt); typed/empty/nested-empty/wrong-scalar payload rejection at write + read; malformed-JSON no-throw (per-row + batch) incl. non-string ids, null arrays, non-object rows; source stored-id/map-key/recomputed triple equality; sparse-array rejection. *Deps:* PR4.3. *Rollback:* additive/flag-gated. *Accept:* full V2 suite + champion lock + migration tests + tsc.

**PR4.3.2 — Provenance matrix + payload-domain validation (review correction).** *Obj:* close two residual read-side bypasses. *Files & fixes:*
- **Full provenance matrix** in the strict reader: `storedSourceEvidenceSchema.availabilitySource` is `z.enum(AVAILABILITY_SOURCES)` (no arbitrary string); a non-null but unparseable timestamp (`"not-a-date"`) is rejected at parse; and the matrix is enforced — *incomplete*: null `fetchedAt`/`availableAt` + `unverified` + `reconstructed:false`; *complete*: valid `fetchedAt`/`availableAt` + non-`unverified` source, `fetched_at` ⇒ `availableAt === fetchedAt`, `provider_published_at`/`provider_issued_at`/`verified_as_of` ⇒ `availableAt ≤ fetchedAt`, `reconstructed === (fetchedAt > predictionAsOf)`, and **reconstructed admitted ONLY for the `verified_as_of` class** (the reader enables verified-as-of retrieval for exactly that source class, so a reconstructed `verified_as_of` source is now correctly admissible, while every other reconstructed source stays excluded).
- **Null-as-absence + impossible-evidence rejection:** `null` is no longer a genuine leaf (`{parkFactor:null}` / `{forecast:[null]}` are semantically empty and rejected). The historical validator now requires count fields to be **nonnegative integers**, sums to be **finite nonnegative**, percentiles to be **finite and within domain** (EV∈[0,130], LA∈[−90,90]), and reapplies the **monotonic count law** (barrel ≤ qualityBBE ≤ BBE ≤ contact ≤ swing ≤ pitch; whiff ≤ swing; HR ≤ PA-ended; xSLG N ≤ qualityBBE; xwOBA N ≤ qualityBBE) at both write and strict read.
*Tests:* provenance-matrix (fetched_at ne, issued available-after-fetched, reconstructed-requires-verified, verified-as-of admitted, bad-enum + unparseable-timestamp shape-invalid no-throw); null-only generic evidence rejected; impossible historical counts (negative, non-integer, whiff>swing, quality>bbe, xslgN>quality, out-of-domain percentile) rejected at write + read; a coherent entry accepted. *Deps:* PR4.3.1. *Rollback:* additive/flag-gated. *Accept:* full V2 suite + champion lock + migration tests + tsc.

**PR4.3.3 — Strict ISO/RFC3339 timestamp contract (review correction).** *Obj:* one shared strict timestamp contract across write and read; malformed provenance can never be conflated with genuine absence. *Files & fixes:*
- **`isoTimestamp = z.string().datetime({ offset: true })`** (strict RFC3339 — Z or explicit offset), applied to evidence descriptors, source snapshots, predictions, and first-pitch fields; `storedTimestamp = z.union([isoTimestamp, validDate]).nullable()` (a valid `Date` refined finite). A `Date.parse`-lax value (`07/01/2026`, `2026-07-01 09:00:00`, `July 1, 2026`) is rejected at parse — a stored source carrying one is `source_shape_invalid` (no throw).
- **`normalizeTimestamp()` rejects malformed non-null input** (throws `PlateHrV2NonCanonicalValueError`) instead of returning `null`, so an invalid string can never collide with real `null` provenance nor silently collapse a content hash. Null/undefined stay genuine absence.
- **Write-side:** every non-null descriptor timestamp is strict-validated before hashing / reconstruction / `new Date(...)` — a bad descriptor timestamp skips that source with a `source_timestamp_invalid` block reason; a bad `predictionAsOf`/`firstPitchTime` is counted as a failed persist, never thrown to the caller.
*Tests:* normalizeTimestamp (null-absence; ISO-Z/offset/Date normalize; the three non-ISO examples throw; malformed != null); read shape-invalid for non-ISO stored timestamps (no throw); write skip + block reason for a non-ISO descriptor timestamp; non-ISO predictionAsOf counted as failed. *Deps:* PR4.3.2. *Rollback:* additive/flag-gated. *Accept:* full V2 suite + champion lock + migration tests + tsc.

**PR5 — Stabilized recent-contact features (LANDED, shadow-only).** *Deps:* PR4.3. *Obj:* EWMA over the most-recent BBE window (cap 50) + EV90 + air%/barrel%, reliability-blended with a season baseline (15-BBE regressed; 25–50 > tiny spike; reliability capped). *As-built (data trace):* the ONLY real per-BBE stream is `contact_events` (`exitVelocity/launchAngle/isBarrel/timestamp` — NO bb_type/spray/xSLG per event). So EV EWMA, EV90, air% (LA≥10), and barrel% are genuinely per-event; **`recentFormPulledAirShare` is season-only** (never fabricated per-event) and **`recentFormXHrPerContact` is always null** (no per-event xSLG stream). Recent HR count can never contribute (`result` never read); bat speed never required. *Files:* new `recentContactForm.ts` (pure) + `recentContactForm.test.ts`; additive contract group in `plateHrV2FeatureContract.ts` / `frozenPlateHrV2Input.ts` / `plateHrV2FeatureBuilder.ts` (mirrors the inert `contactOpportunity` slot; NOT in `toPregameMathInputs`); added to `AUTHORIZED_DERIVED_FEATURE_GROUPS`. Default-prior constants (half-life/K/cap/air-threshold) refined out-of-sample in PR8. **No math consumer or production wiring yet** (PR6). *Tests:* HR count can't fire; 15-BBE regressed; 25–50 BBE > spike; reliability monotonic + capped; leakage boundary; EV90/air%/barrel% from events; pulled-air season-only; xHR null; missing EV/LA degrade; missing bat speed tolerated; neutral-when-empty. *Rollback:* shadow-only. *Accept:* invariants green + champion lock 78/78 + tsc (met).

**PR5.1 — Version the recent-contact-form contract + reproducible evidence + fail-closed math (review correction, LANDED).** *Obj:* close four PR5 gaps. *Fixes:*
- **Versioned contract (no in-place V1 mutation):** V1 derived/availability schemas restored WITHOUT `recentContactForm`; new **V2** contract (`PLATE_HR_V2_FEATURES_V2`) = V1 + `recentContactForm`. New snapshots write `PLATE_HR_V2_FEATURES_CURRENT` (= V2): builder emits V2, forward capture stamps V2. A discriminated-union reader (`plateHrV2DerivedFeatureVectorAnySchema`) parses historical V1 + current V2; `resolveSingleFeatureVersion()` rejects mixed versions in one training artifact.
- **Reproducible, content-addressed evidence:** new `contact_events` evidence kind (historical point-in-time rule) + strict payload validation. `buildRecentContactFormEvidence()` emits the leaf AND the content-hashed payload (windowed raw events + season baseline + boundary + windowMax) with point-in-time metadata (`dataThroughAt` = max event time; `fetched_at` provenance); `recomputeRecentContactFormFromEvidence()` re-derives the exact leaf (round-trip test). `buildPregamePowerRadar` wires the already-batched contact-event rows into shadow capture and appends the evidence to `sourceSnapshotIds`.
- **Fail-closed leakage/window:** a non-finite boundary → neutral (never disabled); window hard-capped at 50; `normalizeWindowMax()` rejects non-positive/fractional/NaN/∞.
- **Per-metric shrinkage:** EV/EV90/air%/barrel% each shrunk by the reliability of THEIR OWN valid count (not the total window); unknown barrel status is missing (never a non-barrel); a season baseline is REQUIRED to surface a stabilized metric (no raw passthrough); baseline domains validated.
*Tests:* V1-parses/V2-requires-group/mixed-version-guard; contact_events eligibility + payload validation + round-trip re-derivation; fail-closed boundary + window normalization; per-metric partial-coverage + missing-baseline + baseline-domain. *Deps:* PR5. *Rollback:* shadow-only. *Accept:* full V2 suite + champion lock 78/78 + shadow isolation 77/77 + migrations + tsc (met).

**PR5.2 — Gateway-enforced versioning + closed/cross-bound evidence + read-time re-derivation (review correction, LANDED).** *Obj:* wire the PR5.1 guards into the authoritative reader and close evidence gaps. *Fixes:*
- **Gateway-enforced V1/V2:** V1/V2 derived schemas are `.strict()`; a strict version-specific AUTHORIZED-PROJECTION schema (full vector minus market/zoneLocation) is added; `evaluatePredictionRowIntegrity()` parses the persisted `derivedFeatures` against the schema for the row's `featureVersion` and requires top-level === embedded version. The gateway returns `admittedByVersion` (partitioned) — never one mixed admitted array.
- **Strict, cross-bound contact_events:** `validateContactEventsPayload` closes top-level/event/baseline fields (rejects `result`/`recentHrCount`), requires a closed+domain-checked `seasonBaseline`, enforces EV/LA domains, integer `windowMax` ≤ 50, `events.length ≤ windowMax`, and every event ts < `asOfExclusiveMs`. The reader cross-binds the source to the prediction (`asOfExclusiveMs` === predictionAsOf; `dataThroughAt` === max event ts; source `schemaVersion` === feature version) — closing the rehashed-future-events bypass.
- **Read-time re-derivation:** for every V2 non-neutral leaf the reader requires exactly one contact_events source, recomputes the leaf, and requires exact canonical equality (rejects missing/duplicate/mismatched/forged-but-rehashed); a neutral leaf must carry no such evidence.
- **Pulled-air correction:** `recentFormPulledAirShare` is ALWAYS null (mislabeled season pull-rate proxy removed); zero events → a fully-neutral leaf (no non-neutral value without evidence).
*Tests:* strict projection + version-binding; partitioned admission; closed/cross-bound validation; read-time re-derivation incl. forged-rehashed; pulled-air-null + neutral-when-empty. *Deps:* PR5.1. *Rollback:* shadow-only. *Accept:* full V2 suite + champion lock 78/78 + isolation 77/77 + slate-invariance 39/39 + migrations + tsc (met).

**PR6 — Corrected starter/bullpen joint PA-path probability.** *Obj:* joint game-HR expectation + per-segment decomposition (§10); opener-aware PA-path; additive fitted-ready terms. *Files:* new `math/estimatePregamePaPath.ts`, `math/gameHrProbability.ts`, `math/scoreStarterBullpenPath.ts`, `math/buildPregameHrPerPa.ts`, `math/scorePitchTypeInteraction.ts`, new `math/scoreRecentContactForm.ts`, `math/mathTypes.ts`. *Tests:* §18 probability block. *Deps:* PR5 (which carries PR4/PR4.3). *Rollback:* shadow-only. *Accept:* property tests green.

**PR7 — Contact-aware zone term (only if PR2 zone spike passes).** *Obj:* normalized-coordinate ingestion + `X_BZ`/`X_PZ` (§8.2, measurable-BBE estimand + frozen `ω^ref`). *Files:* `dataSources.ts` (coords/normalization/orientation fixtures), new `zoneAggregation.ts`, `math/scoreZoneLocationInteraction.ts`, contract/schema/migration. *Tests:* orientation fixtures; **high-whiff/low-BBE hot cell → no edge**; `δ`-vs-frozen-reference no double-count; pitcher term does not self-center to 0; sparse cells regress; deterministic smoothing. *Deps:* PR2 green, PR6. *Rollback:* `PLATE_ZONE_ENABLED`. *Accept:* spike passed + tests; else deferred (documented).

**PR8 — Fit + calibrate + refitted ablations + baseline calibration + sealed gate spec.** *Obj:* **first** author and seal the gate spec, **then** fit β out of sample; Platt-vs-isotonic chosen pre-Test on Calibration/Selection; calibrate current composite into a probability (training-only mapping) as baseline; fully-refitted ablations with component selection on Calibration/Selection; freeze the candidate; open Test once. *Files:* **new `docs/plate/plateHrV2GateSpec.md` + `docs/plate/plateHrV2GateSpec.json`** (signed; approver recorded; content hash written into `plate_hr_v2_model_registry` **before** Test), `plateHrV2ShadowFitting.ts`, `plateHrV2Calibrator.ts`, `math/calibratePregameHrProbability.ts` (fitted drop-in), new `math/calibrateBaselineComposite.ts`, `plateHrV2ModelArtifactWriter.ts` (embeds gateSpec hash + approver), new `scripts/fitAndEvaluatePlateHrV2.ts`. *Tests:* calibrator; leakage; refit-ablation-on-Calibration; no-default-prior-surfaced guard; gateSpec-hash-present-in-registry-before-Test guard; single-Test-open guard. *Deps:* PR6 (+PR7 if present) + minimum captured outcomes (§22). *Rollback:* registry-only. *Accept:* §22 gates, evaluated once against the sealed spec.

**PR9 — Versioned challenger publication policy (champion path untouched).** *Obj:* build qualification = calibrated-prob threshold **AND** required core evidence **AND** no material suppressor (optional evidence never disqualifies, §9) as a **challenger policy**; the **champion production path is not modified**. *Files:* `modelVersions/plateChallengerCurrent.ts`, new `modelVersions/plateProbabilityQualification.ts`, `evidenceFamilies.ts` (core-vs-optional classes), `platePublicationDecision.ts` (challenger branch only, behind flag), comparison in `plateModelComparison.ts`. *Tests:* qualification independent of tag/driver counts and odds; optional-missing ≠ disqualify; champion output byte-identical (isolation test). *Deps:* PR8. *Rollback:* challenger flag off. *Accept:* challenger reproducible from prob+core-coverage+suppressors; zero champion drift.

**PR10 — Versioned API diagnostics (admin only).** *Obj:* component log-odds, coverage, shrinkage, pre/post calibration, tag qualify/reject reasons — admin. *Files:* `diagnostics.ts`, `math/mathDiagnostics.ts`, `statsRoutes.ts`, new `admin/PlateHrV2DiagnosticsCard.tsx`. *Tests:* payload + read-only; **public DTO carries no shadow/uncalibrated probability**. *Deps:* PR8. *Rollback:* remove route/card. *Accept:* diagnostics render; no public change.

**PR11 — Coherent authority release: model + tags + UI, one flag.** *Obj:* behind a single `PLATE_PROBABILITY_ENABLED`, switch production authority to the challenger/calibrated policy, activate evidence tags (Exact Pitch-Mix Edge / Attack-Zone Match / Barrel Surge / Park-Spray Fit / Complete Power Match) + real Elite-ISO threshold (fitted artifact), derive `score10` from probability, ship card/API. *Files:* `evaluatePlateModel.ts`/`buildPregamePowerRadar.ts` (authority switch + **atomic artifact-fallback**, §14), `modelVersions/plateProbabilityFlags.ts`, new `plateTagContract.ts`/`plateTagAssembler.ts`, `types.ts`/`diagnostics.ts` (DTO §14), `PregamePowerRadar.tsx`, new server `plateSetupGrade.ts`, `shadowOutcomes.ts`/`winAttribution.ts`/`gradedStateCarry.ts`/`pregamePersistence.ts`, schema+migration; goldmaster re-baseline. *Tests:* §18 tags/UI; freeze/grade; no client recompute; **API authority matrix (§14) incl. no-hybrid fallback**. *Rollback:* single flag → the **PR0-adjusted champion contract** (probability/score/grade/qualification/tags/ranking/contract-version) **together** — restores the PR0 **suppressed-Elite** champion, never the pre-PR0 universal legacy Elite tag. *Accept:* §22 gates hold with flag on.

**PR12 — Limited exposure + rollback verification.** *Obj:* cohort exposure; one-toggle rollback restores probability + qualification + tag + grade authority together, no data loss. *Files:* `plateProbabilityFlags.ts` (cohorts), runbook. *Tests:* flag matrix; rollback drill. *Deps:* PR11. *Accept:* staged gates hold; rollback verified.

---

## 14. API contract & authority behavior (Rev. 3)

DTO additions (server-authored, nullable, versioned) on `PregamePowerDiagnostics` + mirrors: `intrinsicPowerScore100`+`percentile` (as-of MLB population), `exactPitchMixScore100`+`percentile`, `pitchZoneMatchScore100`+`percentile` *(if 2A ships)*, `pitcherVulnerabilityScore100`+`percentile`, `recentContactFormScore100`+`percentile`, `parkSprayScore100`+`percentile` *(real geometry only)*, `projectedPa{vsStarter,vsBullpen,meanPa}`, `evidenceConfidence`+`effectiveSampleByFamily`, `coreEvidencePresent`/`optionalEvidencePresent[]`, `missingDataReasons[]`, `qualificationState`+`qualificationReasons[]`, `tags[]` versioned `{id,label,tone,priority,evidence}`, `modelVersion`,`featureVersion`,`dataFreshness{savantAt,splitsAt,weatherAt,lineupAt,probableAt}`. On `PregamePowerSignal`: `gameHrProbability`, server `setupGrade`, `tagContractVersion`.

**Authority matrix (public) — the fallback is ATOMIC across the whole authority bundle** `{probability, score10, grade, qualification, tags, defaultRanking, contractVersion}`:
- Authority **off** → entire bundle from the **PR0-adjusted champion path**; `gameHrProbability = null`.
- Authority **on + valid calibrated artifact** → entire bundle from the calibrated/challenger policy; `gameHrProbability` = calibrated probability.
- Artifact **missing/invalid** → entire bundle **reverts to the PR0-adjusted champion path** and emits `[PLATE_ARTIFACT_FALLBACK]`; `gameHrProbability = null`. **No hybrid champion/challenger response** — a single field is never sourced from a different authority than the rest.
- Shadow / uncalibrated probabilities → **admin-only, never public.**

No misleading precision; odds shown separately, never a model input or a ranking key.

---

## 15. Tag migration & selectivity (Rev. 3)

Tags **explain** the probability; they **never** vote on qualification. Versioned server-authored contract + single assembler: deterministic priority, cap 4, redundant-tag suppression, **fail-closed on missing evidence**, per-tag coverage/outcome tracking, versioned thresholds, **no daily volume quota** (issuance varies naturally with slate quality).

- **Now (PR0):** **suppress `power_iso` only** — no relabel, no substitute artifact, no hardcoded cutoff. Suppression is display-layer so champion qualification is unchanged (§PR0). Real activation (PR11) uses a **fixed absolute skill floor established from historical training data and frozen in the artifact** + a **fixed as-of MLB-population percentile** + an **effective-sample floor**.
- **Matchup tags** (Exact Pitch-Mix Edge, Attack-Zone Match, Barrel Surge): **not public while shadow-only** — admin diagnostics until the calibrated release (PR11).
- **Park-Spray Fit:** only if real launch-direction→park/weather mapping fires. **Complete Power Match:** strong intrinsic power + multiple **independent** matchup edges; calibrated-model only; rare by construction.
- `positiveDriverCount`/tag counts removed from qualification (PR9).

---

## 16. Plate UI plan

Smallest legible change, no page redesign. **Compact:** name/matchup/server grade; ≤4 versioned tags by priority; one Game-HR-probability pill (whole %); park/weather + pull-rate; odds shown separately/benchmark, never influencing order. **Expanded "Why this target":** component percentile bars (Intrinsic Power / Exact Pitch-Mix / Pitch-Zone / Pitcher Vulnerability / Recent Contact Form / Park-Spray) with plain-language labels separating intrinsic skill vs matchup vs form vs environment; evidence-confidence; explicit missing/stale/partial + qualified-vs-not states. Server authority: grade + BvP banding moved server-side; client renders facts only.

---

## 17. Backtest & calibration (Rev. 3)

- **Splits:** strictly time-ordered **Train → Calibration/Selection → untouched Test**; Test opened **once**, after gates pre-registered.
- **Baseline:** current composite calibrated into a probability via a **training-only** mapping (`math/calibrateBaselineComposite.ts`).
- **Ablations:** every ablation **fully refit** (never zeroing a coefficient after fitting): baseline, +pitch-mix, +zone, +recent-contact, +all, all-minus-each. **Selection/removal of non-lifting components happens on Calibration/Selection only**; the resulting component set is frozen before Test (§22 Test-set protection).
- **Calibrator:** Platt vs isotonic chosen on Calibration/Selection **before** Test.
- **Uncertainty:** **paired slate-day cluster bootstrap** (the `plateHrV2GateSpec` default; players in a game — and games in a slate — are not independent) on candidate-minus-baseline metric differences. The single chosen procedure is defined once in the gate spec.
- **Frozen inputs:** claimed only where as-of inputs are actually reconstructable (§7.1); else forward-capture.
- **Market benchmark:** timestamp-matched, consensus, de-vigged; external benchmark only.
- **Metrics:** log loss, Brier, calibration intercept/slope, reliability, ECE, ceiling (probability); lift-by-decile, HR-rate by grade/tag, precision@daily-targets, coverage, stability across months/parks/hand/sample (product). ROC/PR-AUC secondary.
- **Explainability fixtures** (Wood-vs-López, Olson/Baldwin-vs-Mikolas): checks only, if as-of inputs exist; not hardcoded, not selection targets, not ground truth.

---

## 18. Tests
**Probability/math:** finite/bounded; Σu=1; **game prob = joint expectation** (matches enumeration); monotone; starter-only never in `p_b`, hitter/form/park always in `p_b`; missing optional → neutral 0; **shrink once**; recent form capped; additive (no signed×signed); no double-count (refit ablation). **Pitch mix:** complete arsenal; order-invariant; low-usage favorable can't dominate; high-usage unfavorable offsets; hand splits correct; unknown code fallback; whiff separate from damage; **no summed ISO**. **Zone (if 2A):** orientation fixtures; low-contact hot cell → no edge; `δ` no double-count; sparse regress; deterministic smoothing; `sz`+plate-width normalization verified. **Recent form:** HR count can't fire; 15-BBE regressed; 25–50>spike; missing bat speed tolerated. **Snapshots (evidenceKind-specific, per §7.1):** append-only; late change → new `predictionAsOf`; composite uniqueness `(gamePk,batterId,featureVersion,predictionAsOf)`. Guards asserted **per `evidenceKind`**: `historical_stat` → `dataThroughAt<predictionAsOf≤firstPitch`; `lineup`/`probable` → `availableAt≤predictionAsOf≤firstPitch`; `weather_forecast` → `availableAt(issuedAt)≤predictionAsOf` with **`validForAt` allowed in the future (must NOT be failed by a `dataThroughAt` guard)**; `park` → `availableAt≤predictionAsOf`. Explicit cases: a valid pregame forecast (issued-before, valid-for-future) is **eligible**; observed post-game weather / a stat with `dataThroughAt≥predictionAsOf` is **excluded**; `reconstructed=true` excluded unless verified as-of retrieval; unestablished-cutoff excluded. **Qualification/tags/UI:** required-core vs optional separation; optional-missing ≠ disqualify; tag counts don't affect qualification; odds don't affect qualification/ranking; API authority matrix (§14); champion isolation (PR9); client no recompute; stale/partial honest.

---

## 19. Flags, shadow, rollout, rollback
1. Elite-ISO suppression (PR0). 2. Contract+persistence (PR1) → **feasibility go/no-go (PR2)** → capture ON, authorized fields only (PR3). 3. Shadow features + corrected probability (PR4–7). 4. Fit/calibrate/ablate (PR8); challenger qualification policy, champion untouched (PR9); admin diagnostics (PR10). 5. **Single authority flag** `PLATE_PROBABILITY_ENABLED` (PR11) flips the whole authority bundle together, fail-closed, **atomic** artifact-fallback to the PR0-adjusted champion. 6. Cohort exposure (PR12) → full rollout after gates. **Rollback:** one toggle restores the full bundle (probability+score+grade+qualification+tags+ranking+contract-version) to the PR0-adjusted champion; registry keeps prior artifact; additive columns → no data loss. Flags: `PLATE_HR_V2_FORWARD_CAPTURE_ENABLED`, `PLATE_ZONE_ENABLED` (PR3-gated), `PLATE_PROBABILITY_ENABLED`.

---

## 20. Observability
Rate-limited bracketed tags, no secrets: `[PLATE_FEATURE_COVERAGE]`, `[PLATE_PITCHMIX_COVERAGE]`, `[PLATE_ZONE_COVERAGE]`, `[PLATE_SHRINKAGE]`, `[PLATE_COMPONENT_CONTRIB]`, `[PLATE_PROB]` (pre/post), `[PLATE_TAG_QUALIFY]`/`[PLATE_TAG_REJECT]`, `[PLATE_TAG_DISTRIBUTION]`, `[PLATE_PROB_DRIFT]`, `[PLATE_ASOF_INCOMPLETE]`, `[PLATE_ARTIFACT_FALLBACK]`, `[PLATE_DATA_SOURCE_FAIL]`, `[PLATE_SLATE_LATENCY]`, `[PLATE_EXTERNAL_API_VOLUME]`. Admin card renders coverage/missingness/shrinkage/calibration + tag distribution.

---

## 21. Risks, blockers, decisions
**[BLOCKER]** data feasibility (licensing/coverage/limits/cost) precedes **capture and** ingestion (PR2, before PR3). **[BLOCKER]** zone availability (PR2); absent → 2A deferred, no mislabeled proxy. **[BLOCKER]** as-of backfill reconstructability incl. provider as-of retrieval (PR2); else forward-capture only. **[RISK]** calibration sample size → PR3 capture must accrue the §22 frozen minimum before PR8. **[RISK]** hand/zone sparsity → hierarchical shrinkage. **[RISK]** qualification-volume shift → validate in shadow before PR11. **[DECISION-product]** composite retired vs probability-derived display post-promotion (plan assumes derived-display). **[PROXY-disclosed]** `contact_events` lacks `xba`/`hitType`; any EV/LA→HR damage estimand is an explicitly-disclosed proxy, versioned separately, never a rename of xwOBA-on-contact.

---

## 22. Acceptance gates — **signed `plateHrV2GateSpec` artifact, frozen before the Test set is opened**

All thresholds/procedures below are committed as a **versioned `docs/plate/plateHrV2GateSpec.md` (+ machine-readable `plateHrV2GateSpec.json`)** artifact — signed and hashed into the model registry **before** the Test set is opened. No value here may be "set later"; the Test is opened exactly once, against the frozen spec. The spec must contain, with **exact** values:
- **Minimum sample:** exact minimum slate-days, games, batter-games, and **HR-positive outcomes** (derived from Train/Calibration data) required before opening Test.
- **Primary metric + bootstrap procedure (exactly one, internally consistent):** the primary metric, and a single precisely-defined bootstrap — **default: paired *slate-day* cluster bootstrap** (resample whole slate-days with replacement; safest given slate-wide dependencies), or an explicitly-specified **two-stage day→game** bootstrap. The chosen procedure, resample count, and RNG seed are frozen in the spec. ("Cluster" is defined once and used consistently — no mixed day-vs-game language.)
- **Confidence level + multiplicity:** CI level and the multiplicity-correction procedure for the per-component ablations.
- **Exact latency & provider-call limits:** slate-generation p95 latency and total provider-call ceilings (absolute numbers).
- **Coverage thresholds:** exact-pitch and zone coverage minima (from the PR2 feasibility audit — never from the Test set).
- **Qualification threshold-selection procedure:** how the calibrated-probability qualification cutoff is chosen on Calibration data.
- **Minimum tag-support requirements:** minimum supporting sample per tag before it may be issued/validated.

**Test-set protection (Rev. 4.2):** **component selection and removal occur on Calibration/Selection only.** The candidate model and its included components are **frozen before Test is opened**. The Test set is evaluated **once**; failure of any Test gate **rejects the candidate** — it may **not** be modified and re-evaluated on the same Test set. A revised candidate requires a **newly sealed, future test window**. (This keeps Test out of model selection.)

**Pass conditions (evaluated once on Test, against the frozen candidate):**
1. **Probability quality:** candidate holdout log loss **and** Brier lower than the calibrated-current-composite baseline, with the **paired cluster bootstrap CI on (candidate − baseline) entirely below 0**.
2. **Calibration:** Test intercept ∈ [−0.10,+0.10] log-odds; slope ∈ [0.90,1.10]; ECE ≤ baseline ECE.
3. **Independent lift (decided on Calibration/Selection, confirmed on Test):** each included component must have improved a **refitted** ablation on Calibration/Selection (cluster CI, multiplicity-corrected); components that failed there were removed **before** freezing. On Test the frozen set is confirmed, not re-selected.
4. **Sample:** the frozen minima are met before Test is opened.
5. **No uncalibrated exposure:** zero public probabilities from default-prior/uncalibrated coefficients (guard test).
6. **Ops:** no per-card external requests; latency & provider calls within the frozen limits.
7. **Coverage:** ≥ the frozen feasibility thresholds.
8. **Tag selectivity/validity:** Elite-ISO gated by a **fixed absolute skill floor + fixed as-of MLB-population percentile + sample floor** (**no daily volume quota**; issuance varies naturally with slate quality). Each evidence tag is validated by comparing **tagged vs untagged players within comparable calibrated-probability bands, with clustered uncertainty** — never a raw tag-vs-non-tag HR-rate comparison.
9. **Qualification independence:** decisions reproducible from calibrated probability + required-core coverage + suppressors alone; odds/tag-count perturbation → zero effect; optional-evidence-missing never disqualifies.
10. **Rollback:** one toggle restores the full authority bundle to the PR0-adjusted champion contract, no data loss (verified drill).

---

## 23. Recommended implementation order (Rev. 3)
1. **PR0** — record SHA; row-level audit; **suppress Elite-ISO at the display layer** (no invented threshold, no relabel; qualification byte-identical).
2. **PR1** — minimum v2 contract + append-only two-layer snapshot persistence (with `availableAt` guard).
3. **PR2** — zone/licensing/coverage/exact-pitch feasibility spikes → go/no-go + backfill decision + authorized-field list (**before capture**).
4. **PR3** — enable versioned forward capture atomically against PR1, authorized fields only.
5. **PR4** — exact-pitch sufficient statistics (`qualityBbeCount` denominators).
5a. **PR4.1 / PR4.2 / PR4.3 / PR4.3.1 / PR4.3.2 / PR4.3.3** — sufficient-stat correctness → write-side evidence hardening → **training-read integrity** (blank-safe parser, honest provenance, one canonical-object source-id used at write+read, strict batch training-reader verifying prediction+source hashes/point-in-time/uniqueness/sort, closed nested allowlist, no `{}` manufacture) → **read-integrity hardening** (`reconstructed` from `fetchedAt`, typed non-empty payloads at write+read, never-throw runtime-parse of untrusted DTOs, triple id-equality, sparse-array rejection) → **provenance matrix + payload-domain validation** (`availabilitySource` enum, unparseable-timestamp rejection, per-source timestamp law, reconstructed-only-verified-as-of, null-as-absence, nonneg-int counts + monotonic count law + percentile domains) → **strict ISO/RFC3339 timestamp contract** (shared write+read, malformed != null, no Date.parse-lax values). **Blocks PR5+.**
6. **PR5** — stabilized recent-contact features (**Deps: PR4.3**).
7. **PR6** — corrected starter/bullpen **joint** PA-path probability.
8. **PR7** — contact-aware zone term **only if** the spike passes.
9. **PR8** — fit, calibrate, **refitted** ablations; calibrate the current composite as baseline.
10. **PR9** — versioned challenger qualification policy **without touching the champion path**.
11. **PR10** — publish versioned API diagnostics (admin).
12. **PR11** — release model + tags + UI together behind **one** authority flag (with artifact-fallback).
13. **PR12** — limited exposure; verify rollback.

---

## Fact-vs-inference ledger
- **Confirmed (`8c818ec`):** two-track architecture; pitch-type ignored (`:1061`); 3-family ingestion; no `plate_x/plate_z`; `zone` unverified; no BBE windows; null projected-PA; identity calibration; default-prior shadow coefficients; `sIso≥6.5` Elite cut; qualification uses `positiveDriverCount≥2`; existing `math/`+`hrProbabilityV2/`; park-spray real; card consumes `PregamePowerSignal`.
- **Inferences:** exact pitch-type derivable from season CSV; recent-contact windows from `contact_events`; hierarchical shrinkage handles sparsity; opener-aware PA-path from workload stats.
- **Recommendations (Rev. 3+4):** two-layer append-only snapshots with `predictionAsOf`+`fetchedAt`/`availableAt`/`dataThroughAt` (Rev. 4 `availableAt≤predictionAsOf`, `reconstructed`-exclusion); explicit grain-typed sufficient statistics with `qualityBbeCount` denominator (no summed ISO); measurable-BBE contact-aware separately-fitted zone deviations centered on a frozen training-only reference `ω^ref`; required-vs-optional evidence; contract→feasibility→capture order; challenger-policy-then-switch rollout with **atomic** authority-bundle fallback to the PR0-adjusted champion; signed `plateHrV2GateSpec` with band-matched clustered tag validation.
- **Unknowns needing data/product decision:** Savant field availability + licensing/coverage/cost (PR2); as-of backfill reconstructability incl. provider as-of retrieval (PR2); calibration sample sufficiency (PR8); composite retire-vs-keep post-promotion; bat-speed/barrel-field coverage.
