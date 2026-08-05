# Plate HR V2 — Data-Source Feasibility & Go/No-Go (PR2)

> **Blocking artifact.** Per plan §6, no new feature is built into a **user-facing**
> production surface until the relevant source clears licensing + coverage + limits +
> cost here. Fail-closed: a field this artifact does not mark **AUTHORIZED** is not
> captured. Baseline commit `8c818ec`; this document authored on the `claude/plate-hr-engine-upgrades-ispzmm` branch.
>
> **Human sign-off required** — see the SIGN-OFF section at the end. The engineering
> spike below is complete; the **commercial-licensing** determinations are legal/business
> decisions this document cannot self-approve.

## 1. Spike run log (field-presence)

Script: `server/mlb/pregamePowerRadar/hrProbabilityV2/scripts/auditSavantFields.ts` (read-only).

| Run | Env | Result |
|---|---|---|
| 2026-08-02, this sandbox | agent-proxied egress | **HTTP 403 from `baseballsavant.mlb.com` → INCONCLUSIVE.** The agent proxy is non-selective and Savant is not in its no-proxy allowlist; Savant rejects the proxied request. |
| 2026-08-04, this sandbox (PR7 pre-gate re-run) | agent-proxied egress | **HTTP 403 again → still INCONCLUSIVE.** Re-ran `auditSavantFields.ts` (player 592450, 2025-04-01..15). Proxy `__agentproxy/status`: `selective:false`, Savant not in `noProxy`, `recentRelayFailures:[]`. The 403 came back through the proxy with no relay failure observed; **whether the block originates at Savant or at an intermediary cannot be proven from this environment.** Either way, the five location fields remain **UNVERIFIED**; the spike must be run in the production/Railway environment (where `fetchBaseballSavantData` succeeds daily) before PR7 can be authorized. |
| **2026-08-05, Railway production shell** (post-merge `aedf22d`) | **production egress (Savant reachable)** | **`ZONE GATE: GO` — VERIFIED.** Ran `auditSavantFields.ts --player 592450 --type batter --season 2025 --from 2025-04-01 --to 2025-04-15`. **254 rows, 119 columns.** All five location fields present and populated at **98.4% (250/254)** each: `plate_x` 98.4%, `plate_z` 98.4%, `zone` 98.4%, `sz_top` 98.4%, `sz_bot` 98.4%. All ≥ 90% coverage threshold → zone fields are now **VERIFIED PRESENT**. Reproducible in production. |

**Consequence (RESOLVED, 2026-08-05):** the §1 spike has now been re-run in the production/Railway environment where Savant is reachable. All five location fields (`plate_x, plate_z, zone, sz_top, sz_bot`) are confirmed present at 98.4% coverage — clearing the ≥90% fail-closed threshold — so they move from **UNVERIFIED → VERIFIED** (see §5). The **data** gate for PR7 is satisfied; user-facing promotion remains separately blocked on the commercial-licensing sign-off (§7).

Re-run command (production env):
```
npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/scripts/auditSavantFields.ts \
  --player <mlbamId> --type batter --season <YYYY> --from <YYYY-MM-DD> --to <YYYY-MM-DD>
```

## 2. Fields proven present by existing production parsing (independent of the spike)

The production engine already fetches these same season `type=details` CSVs daily
(`server/mlb/dataSources.ts::fetchBaseballSavantData`) and successfully reads the
columns below — so their presence is established by production runtime, not by this
sandbox spike. These are the columns the current parser consumes:

`game_pk, game_date, player_name, pitch_type, events, description, stand, p_throws,
launch_speed, launch_angle, launch_speed_angle, estimated_ba_using_speedangle,
estimated_slg_using_speedangle, bb_type, hc_x, hc_y` (plus `bat_speed`/`swing_length`
consumed by the shadow bat-tracking aggregator, coverage 2023+ only).

> **Correction (2026-08-04):** `launch_speed_angle` **is** parsed by production today
> (`dataSources.ts` reads column `launch_speed_angle` and classifies it — e.g. the
> `toppedPct` soft-gate input, `lsa==2`). Its **presence is therefore established by
> production runtime**, exactly like the other §2 columns; the earlier "pending spike"
> wording below was inaccurate as to availability. What is NOT yet adopted is *using the
> official barrel classification* (`lsa==6`) as the barrel RATE — production still uses
> the EV≥98 & LA∈[20,35] **proxy**. That is a **modeling choice**, not a data-availability
> gate, and is deferred to the fitting phase; it does not depend on the Savant spike.

## 3. Per-source feasibility

| Question | Baseball Savant CSV | MLB Stats API | Open-Meteo | Odds API |
|---|---|---|---|---|
| Already used in prod | ✅ (`dataSources.ts`) | ✅ (rosters/lineups/probables/splits) | ✅ (weather) | ✅ (display only) |
| Commercial-use / licensing for a paid product | **UNRESOLVED — SIGN-OFF REQUIRED** | UNRESOLVED — sign-off | Open-Meteo non-commercial vs commercial tier — **sign-off** | contracted (display only) |
| Historical coverage | season CSVs date-bounded; bat_speed 2023+; `launch_speed_angle` **present & parsed in prod today** (official-barrel-rate *adoption* is a deferred modeling choice, not an availability gate) | current only for lineups/probables | forecasts not archived | n/a to model |
| Cadence vs 6am-ET slate build | daily (prod cache 4h) | daily | hourly | n/a |
| Endpoint/rate limits, bulk allowance | **no per-card calls** (slate-level, cached) — verify bulk quota | existing usage | existing usage | quota-managed |
| Cost at slate volume | reuses already-fetched prod responses → no new spend | existing | existing | n/a |
| Field-level presence (zone/coords/barrel/bat_speed) | **SPIKE (see §1) — currently UNVERIFIED** | n/a | n/a | n/a |

**Important scope distinction.** PR3 forward capture is **shadow/research only** (gated by
`PLATE_HR_V2_FORWARD_CAPTURE_ENABLED`, default off, no publication authority) and derives
its features from the **Savant responses production already fetches and stores** — it issues
**no new provider requests** and introduces **no new data class** beyond current production
usage. Therefore PR3 shadow capture inherits production's existing data posture. A formal
**commercial-licensing review is still required before any user-facing promotion** (PR11),
which is gated separately behind the calibrated-authority flag.

## 4. Frozen coverage thresholds (for §22 gates; confirm at PR8 sealing)

These are frozen HERE (before any Test set) and copied into `plateHrV2GateSpec` at PR8:

- **Exact pitch-type cell** eligible when `bbeCount ≥ 15` (else pool to family → league).
- **Damage-on-contact quality coverage**: a cell contributes damage only when
  `qualityBbeCount / bbeCount ≥ 0.90` (else revert to pitch-mean/prior). See plan §8.2.
- **Pitcher usage** `u_p` computed over the last `N = 5` starts (recency horizon).
- **Zone cell** (if PR7 authorized): eligible when `bbeCount_{p,z} ≥ 8` with adjacent-zone
  smoothing; else pool. **Zone spike PASSED 2026-08-05 (§1); data gate satisfied. Activation
  still gated on PR7 authorization + commercial-licensing sign-off (§7).**
- **Bat speed**: used only for 2023+ players with ≥ 40 competitive swings; absent → no-op.

## 5. Authorized-field list for PR3 capture (FROZEN)

**AUTHORIZED** (proven present by production parsing, §2; shadow capture reuses already-fetched data):

- Identity/context: `game_pk, game_date, player_name, batter, pitcher, events, description`
- Handedness: `stand, p_throws`
- Pitch type: `pitch_type` (exact code)
- Contact quality: `launch_speed, launch_angle, launch_speed_angle,
  estimated_ba_using_speedangle, estimated_slg_using_speedangle,
  estimated_woba_using_speedangle, bb_type, hc_x, hc_y`
  (PR4.1: `estimated_woba_using_speedangle` authorized here — production already
  reads it as `xwOBASeason`; used as an xwOBA-on-contact statistic, never as P(HR|BBE).
  2026-08-04: `launch_speed_angle` authorized here — production already parses it
  (§2). Its official-barrel classification `lsa==6` may be *adopted* as the barrel
  rate at the fitting phase; until then Upgrade 1 uses the EV≥98 & LA∈[20,35]
  **proxy**, labeled a proxy, never "official barrel". This is a modeling choice,
  not a data-availability gate.)

**AUTHORIZED — pitch location / zone (FROZEN 2026-08-05 by the production §1 spike).**
The zone data gate is **satisfied**. The authorized location-field list is frozen to exactly
these five fields, each verified present at **98.4% (250/254)** in the production spike
(≥ 90% threshold cleared):

- `plate_x`
- `plate_z`
- `zone`
- `sz_top`
- `sz_bot`

No sixth location field is authorized; no proxy may be substituted for a missing value or
labeled as zone modeling. Zone-cell eligibility still applies the §4 sample floor
(`bbeCount_{p,z} ≥ 8`, adjacent-zone smoothing, else pool). **Capture/modeling use of these
fields for any user-facing surface remains gated on the Baseball Savant/Statcast commercial-use
authorization (§8.2) — the source these five fields actually come from. Open-Meteo is not a
dependency of the zone upgrade (§8.1).**

**AUTHORIZED-CONDITIONAL** (present in prod but coverage-limited — capture allowed, use gated):

- `bat_speed, swing_length` — 2023+ only; feature no-ops below the swing-sample floor.

## 6. Go/No-Go decisions

| Item | Decision |
|---|---|
| PR3 exact-pitch sufficient stats (Upgrade 1) | **GO** — from AUTHORIZED fields. `launch_speed_angle` is present & parsed today; barrel uses the EV/LA **proxy** by modeling choice (official `lsa==6` adoption deferred to fitting), not a data gap. |
| PR5 recent-contact windows (Upgrade 2B) | **GO** — from AUTHORIZED contact-quality fields + `contact_events`. |
| PR7 pitch×zone (Upgrade 2A) | **ZONE DATA GATE: GO / BASEBALL SAVANT-STATCAST LICENSING: BLOCKED** — all five location fields VERIFIED present at 98.4% in the 2026-08-05 production spike (§1), clearing the ≥90% threshold; authorized-field list frozen (§5). PR7 is blocked **specifically** because its own data source — Baseball Savant/Statcast — lacks commercial-use authorization (§8.2). **Open-Meteo is NOT a PR7 dependency** (PR7 imports no weather features) and does not gate it (§8.1). No proxy. |
| Bat-speed feature | **CONDITIONAL GO** — 2023+ only, sample-gated, no-op otherwise. |
| Any user-facing promotion (PR11) | **BLOCKED on commercial-licensing sign-off** (§7). |

## 7. SIGN-OFF (human)

- [ ] **Baseball Savant/Statcast commercial-use authorization — UNRESOLVED. This is the sole remaining PR7 blocker (§8.2), because Statcast is PR7's actual data source.** approver, date:
- [ ] **Open-Meteo commercial-use compliance — UNRESOLVED, but tracked as a SEPARATE production-compliance repair (§8.1), NOT a PR7 gate. It blocks PR7 only if a future PR7 revision imports weather features.** approver, date:
- [x] §1 spike re-run against live Savant; per-field coverage recorded above — Railway production shell, 2026-08-05 (post-merge `aedf22d`; all five location fields 98.4%, `ZONE GATE: GO`).
- [x] Authorized-field list (§5) and coverage thresholds (§4) confirmed frozen — 2026-08-05 (five zone fields frozen in §5; §4 thresholds unchanged).

**PR7 status: `ZONE DATA GATE: GO / BASEBALL SAVANT-STATCAST LICENSING: BLOCKED`.** The data/coverage
gate is satisfied and the authorized-field list is frozen, but the Baseball Savant/Statcast
commercial-use box above is unchecked. Until it is checked, work proceeds **shadow-only** (research
tables, no user-facing probability), consistent with the existing
`PLATE_HR_V2_FORWARD_CAPTURE_ENABLED`-gated posture. No PR7 implementation, no zone capture,
no `starterBullpen` use in PR8 fitting, no champion/public change. **Fetcher wiring is a separate
authorization decision and is not bundled into this licensing resolution.**

## 8. Commercial-licensing record (substantive — not a checkbox)

The §7 licensing block is a **substantive legal/business determination**, not a repository
formality. It is **two independent tracks**, not one combined gate:

- **§8.2 Baseball Savant/Statcast** is **PR7's gate** — Statcast is the source of the five
  verified pitch-location fields PR7 consumes.
- **§8.1 Open-Meteo** is a **separate production-compliance repair** for the existing weather
  pipeline. It is **NOT a PR7 dependency** (PR7 imports no weather features) and must not be
  bundled into the PR7 gate. It would only touch PR7 if a future PR7 revision imported weather.

Each subsection states what is currently true in the code and what the approval record must contain.

### 8.1 Open-Meteo — separate production-compliance repair (NOT a PR7 gate)

**Scope note:** this is an existing-production weather-pipeline compliance item, tracked
**independently** of PR7. PR7 (the pitch×zone upgrade) imports **no** weather features, so
Open-Meteo does not gate it. It is recorded here because the licensing review surfaced it, not
because it blocks the zone work.

**Current code posture (verified 2026-08-05):** `server/mlb/dataPullService.ts::syncOpenMeteoWeather`
calls **`https://api.open-meteo.com/v1/forecast`** — the **free endpoint, with no customer API
key** (`User-Agent: LiveLocks/1.0`). It is **not** the paid `customer-api.open-meteo.com` endpoint.
The production MLB engine calls this endpoint on the live and pregame paths (e.g.
`liveGameOrchestrator.ts`, `buildPregamePowerRadar.ts`), so the endpoint **is** actively used in
production today.

**Constraint:** Open-Meteo's free API is expressly limited to **non-commercial use**; a
subscription-based product is commercial use and requires a **paid commercial plan** on the
customer endpoint (API key). Open-Meteo data is **CC BY 4.0**, so **attribution is also required
wherever the weather data is displayed**.

**Open-Meteo pipeline status:**

```
CURRENT ENDPOINT: api.open-meteo.com
COMMERCIAL PLAN/KEY: ABSENT
STATUS: COMMERCIAL USE BLOCKED
```

**Remediation (separate production-compliance repair — pick one):**

1. Move to the paid `customer-api.open-meteo.com` endpoint with a **secret-managed API key**
   (Railway env var, never hardcoded) and the required **CC BY 4.0 attribution** wherever weather
   is displayed; or
2. **Disable Open-Meteo ingestion in commercial production** until (1) is complete.

**Do not mark Open-Meteo "NOT USED"** merely because PR7 does not consume it — the existing
production engine still calls the endpoint elsewhere, so the compliance obligation stands
regardless of PR7. The sign-off for this track must record: **plan, endpoint, account owner,
attribution location, and permitted APIs.**

### 8.2 Baseball Savant / MLB (Statcast)

**Constraint:** MLB's current terms limit ordinary use to **personal, non-commercial use without
written permission** and **prohibit automated scripts** used to collect information from MLB
Digital Properties. A paid product's **recurring Baseball Savant CSV ingestion** therefore needs
qualified legal review and likely **written MLB permission** or a **properly licensed replacement
source**. An internal checkbox is **not** sufficient. If MLB permission cannot be secured, use a
**commercially licensed baseball-data provider** — do not reinterpret the public-site terms.

**Approval record must identify:**

- Exact Statcast/Search CSV endpoint.
- Automated request frequency.
- Data retained and retention period.
- Whether raw data is redistributed or only transformed model output is shown.
- Use inside a paid betting-analytics product.
- Written MLB authorization, licensed-vendor agreement, or counsel's documented basis for proceeding.

**Actual next decision for the Statcast dependency (choose exactly one, then document it):**

1. **Obtain written MLB authorization**; or
2. **Have qualified counsel document a defensible commercial-use basis**; or
3. **Replace Savant ingestion with a commercially licensed provider** that supplies the five
   required pitch-location fields (`plate_x, plate_z, zone, sz_top, sz_bot`).

Until one of these is documented, keep: **PR7 blocked, zone capture disabled, no proxy fields,
no PR8 fitting using zone features, champion and public paths unchanged.**

### 8.3 PR7 authorization rule (zone upgrade)

PR7 (the zone-location upgrade using the five verified Savant fields) becomes authorized **only**
after this record is completed and committed. Open-Meteo is **not** a line item here — it is not a
PR7 dependency (§8.1):

```
ZONE DATA GATE: GO
BASEBALL SAVANT / STATCAST LICENSING: APPROVED
OPEN-METEO: NOT A PR7 DEPENDENCY, unless PR7 imports weather features
APPROVER:
DATE:
EVIDENCE/AGREEMENT REFERENCE:
```

**Current record (2026-08-05):**

```
ZONE DATA GATE: GO
BASEBALL SAVANT / STATCAST LICENSING: BLOCKED (no written MLB permission / licensed source on file — §8.2)
OPEN-METEO: NOT A PR7 DEPENDENCY, unless PR7 imports weather features (separate compliance repair — §8.1)
APPROVER: —
DATE: —
EVIDENCE/AGREEMENT REFERENCE: —
```

Until the Baseball Savant/Statcast line reads `APPROVED`: **PR7 remains blocked, zone capture is
disabled, no proxy fields are allowed, PR8 fitting does not use zone features, and champion /
public paths remain unchanged.** Open-Meteo (§8.1) is tracked and remediated on its own separate
production-compliance track. **Fetcher wiring is a separate authorization decision and is not
bundled into either licensing resolution.**
