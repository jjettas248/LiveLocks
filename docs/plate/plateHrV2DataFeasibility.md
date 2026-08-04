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
| 2026-08-04, this sandbox (PR7 pre-gate re-run) | agent-proxied egress | **HTTP 403 again → still INCONCLUSIVE.** Re-ran `auditSavantFields.ts` (player 592450, 2025-04-01..15). Proxy `__agentproxy/status`: `selective:false`, Savant not in `noProxy`, `recentRelayFailures:[]` — i.e. an application-level block by Savant, not a TLS/proxy fault. The five location fields therefore remain **UNVERIFIED**; the spike must be run in the production/Railway environment (where `fetchBaseballSavantData` succeeds daily) before PR7 can be authorized. |

**Consequence (fail-closed):** every field whose live presence this spike could not confirm is **UNVERIFIED → UNAUTHORIZED** until the spike is re-run where Savant is reachable (the production/Railway environment, where `fetchBaseballSavantData` already succeeds daily). The spike must be re-run and its per-field coverage recorded in this table before the zone gate (PR7) or bat-speed/official-barrel features may be authorized.

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
launch_speed, launch_angle, estimated_ba_using_speedangle,
estimated_slg_using_speedangle, bb_type, hc_x, hc_y` (plus `bat_speed`/`swing_length`
consumed by the shadow bat-tracking aggregator, coverage 2023+ only).

## 3. Per-source feasibility

| Question | Baseball Savant CSV | MLB Stats API | Open-Meteo | Odds API |
|---|---|---|---|---|
| Already used in prod | ✅ (`dataSources.ts`) | ✅ (rosters/lineups/probables/splits) | ✅ (weather) | ✅ (display only) |
| Commercial-use / licensing for a paid product | **UNRESOLVED — SIGN-OFF REQUIRED** | UNRESOLVED — sign-off | Open-Meteo non-commercial vs commercial tier — **sign-off** | contracted (display only) |
| Historical coverage | season CSVs date-bounded; bat_speed 2023+; `launch_speed_angle` (official barrel) 2015+ **pending spike** | current only for lineups/probables | forecasts not archived | n/a to model |
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
  smoothing; else pool. **Not active until the zone spike passes.**
- **Bat speed**: used only for 2023+ players with ≥ 40 competitive swings; absent → no-op.

## 5. Authorized-field list for PR3 capture (FROZEN)

**AUTHORIZED** (proven present by production parsing, §2; shadow capture reuses already-fetched data):

- Identity/context: `game_pk, game_date, player_name, batter, pitcher, events, description`
- Handedness: `stand, p_throws`
- Pitch type: `pitch_type` (exact code)
- Contact quality: `launch_speed, launch_angle, estimated_ba_using_speedangle,
  estimated_slg_using_speedangle, estimated_woba_using_speedangle, bb_type, hc_x, hc_y`
  (PR4.1: `estimated_woba_using_speedangle` authorized here — production already
  reads it as `xwOBASeason`; used as an xwOBA-on-contact statistic, never as P(HR|BBE))

**AUTHORIZED-CONDITIONAL** (present in prod but coverage-limited — capture allowed, use gated):

- `bat_speed, swing_length` — 2023+ only; feature no-ops below the swing-sample floor.

**UNAUTHORIZED — pending re-run of the §1 spike against live Savant (fail-closed):**

- Official barrel: `launch_speed_angle` → until verified, Upgrade 1 uses the existing
  **EV≥98 & LA∈[20,35] barrel proxy** (labeled a proxy, never "official barrel").
- Pitch **location / zone**: `plate_x, plate_z, zone, sz_top, sz_bot` → **PR7 (Upgrade 2A)
  is NO-GO** until all five are confirmed present and ≥ 90% populated. No proxy may be
  labeled as zone modeling.

## 6. Go/No-Go decisions

| Item | Decision |
|---|---|
| PR3 exact-pitch sufficient stats (Upgrade 1) | **GO** — from AUTHORIZED fields; barrel via proxy until `launch_speed_angle` verified. |
| PR5 recent-contact windows (Upgrade 2B) | **GO** — from AUTHORIZED contact-quality fields + `contact_events`. |
| PR7 pitch×zone (Upgrade 2A) | **NO-GO (deferred)** — location fields UNVERIFIED (§1). Re-run spike in prod; revisit. |
| Bat-speed feature | **CONDITIONAL GO** — 2023+ only, sample-gated, no-op otherwise. |
| Any user-facing promotion (PR11) | **BLOCKED on commercial-licensing sign-off** (§7). |

## 7. SIGN-OFF (human)

- [ ] Commercial-use / licensing reviewed for Baseball Savant (and Open-Meteo tier) — approver, date:
- [ ] §1 spike re-run against live Savant; per-field coverage recorded above — approver, date:
- [ ] Authorized-field list (§5) and coverage thresholds (§4) confirmed frozen — approver, date:

Until the first box is checked, work proceeds **shadow-only** (research tables, no user-facing
probability), consistent with the existing `PLATE_HR_V2_FORWARD_CAPTURE_ENABLED`-gated posture.
