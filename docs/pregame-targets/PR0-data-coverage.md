# PR0 — Source / Feature & Historical-Coverage Matrices

**Status:** PR0 discovery. **Nothing in this document was verified by live API
calls** — this sandbox has no `ODDS_API_KEY`, no `DATABASE_URL`, and no outbound
access to the NBA Stats / odds providers. Consequently, **the existence of an
adapter method is NOT treated as proof that three-season historical data is
physically retrievable** (PR0 correction #5). Every "capability" row is marked
`UNVERIFIED` until PR1's replay harness proves it against a real as-of pull.

## Availability legend (PR0 correction #4)

| Code | Meaning |
| --- | --- |
| **A — verified-available** | Data physically confirmed present (in DB or a captured snapshot) at the required granularity. *(Nothing qualifies yet — no DB in sandbox.)* |
| **R — adapter-retrievable** | A code path/adapter exists that *should* return it, but three-season depth, `knownAt` fidelity, and rate limits are **unverified**. |
| **U — capability-unverified** | A provider is believed to expose it, but no adapter is wired and nothing confirms it. |
| **M — missing / backfill** | No source or adapter; requires ingestion/backfill before use. |

---

## 1. NBA feature-availability matrix (today vs. must-build)

| Feature family | Spec ref | Current asset | Class | Notes / gap |
| --- | --- | --- | --- | --- |
| Player game logs | §6.2 | `nbaStatsService.getPlayerGameLogs` | **R** (current season only) | Adapter takes **no season param** — hard-codes `getCurrentSeason()` (`nbaStatsService.ts:414,422`), so **prior seasons are `M`** (must-build: add a season parameter) — a confirmed code gap, not just unverified depth. `knownAt` unverified. |
| Team game logs / pace | §6.2 | `nbaStatsService.getTeamGameLogs` | **R** (current season only) | Same **no-season-param** gap (`getCurrentSeason()`, `nbaStatsService.ts:474,486`) → prior seasons **`M`**. Pace as *distribution* (§6A.4) not built — only point rates today. |
| Minutes (pregame projection) | §6A.3 | `minutesProjectionService` | **R** | Returns a projection, **not** a bounded role-aware mixture distribution. |
| Rotation / role state | §5B.6 | `nbaRotationHistoryService.getPlayoffRotationProfile` | **R** | Has `dataSource` provenance; **role-state segmentation by dated lineup is missing**. |
| Injury / availability scenarios | §6.3, §6A.2 | — | **M** | No scenario-weighted availability tree; only ad-hoc live handling. |
| Teammate on/off | §6.2 | partial (rotation profile) | **U** | Lineup-quality-adjusted on/off not built. |
| Opponent scheme (continuous vector) | §6A.10 | — | **M** | Only archetype labels exist; no dated `Z_def` vector. |
| DvP residual (pace/role-adjusted) | §6A.11 | — | **M** | No residualized DvP; spec forbids raw rank. |
| Spread / total (game context) | §6A.4 | `oddsService.getGameLines` | **R** | Available as a game-context prior; provenance-stamping for as-of use is a PR1 task. |
| Per-minute rates w/ shrinkage | §6.2 | `probabilityEngine` blend | **R** (weaker) | Static 0.45/0.35/0.20 blend — **not** hierarchical Bayesian posteriors (§5B.5). |

## 2. NFL feature-availability matrix — **entirely greenfield**

There is **no** `server/nfl/`, no NFL entry in the `Sport` union
(`shared/canonicalSignal.ts` = `mlb|nba|ncaab`), no NFL book list, and no NFL
entitlement. Every §7.2 input family is class **M (missing / backfill)**:
schedules/rosters, snaps, routes, targets, carries, air yards, personnel,
coverage/front, plays, weather, depth charts, actives, coordinator tendencies,
college/rookie priors. NFL data ingestion is a full PR6 workstream.

---

## 3. Historical-coverage matrix — per season, NOT collapsed (PR0 correction #4)

The temporal contract (§5B.1) requires **current season + previous two completed
seasons, kept separate** (current = primary evidence; priors decayed, never a
3-season average). Example labels below use the rolling window as of the
`slateDateET()` cutoff; treat them as illustrative, not hard-coded.

### 3a. NBA (illustrative window: current 2025-26 · prior-1 2024-25 · prior-2 2023-24)

| Dimension | Value |
| --- | --- |
| **Source** | NBA Stats API via `nbaStatsService` (unofficial endpoints) |
| **Granularity** | Per-game box; play-by-play/tracking (shot loc, potential assists, rebound chances) **unverified** through current adapter |
| **Identifiers** | NBA `playerId` (int), team tricode, `gameId` — canonical-resolution/fail-closed on trades/dupes **not built** (§5A.2) |
| **`validAt` / `knownAt`** | **Not captured today.** Logs are read live; no as-of feature store exists → no `knownAt <= predictionAt` guarantee. **This is the single biggest PR1 gap.** |
| **As-of replay suitability** | **Unproven.** Requires the PR1 feature store + replay harness before any backtest claim. |
| **Rate limits** | NBA Stats is aggressively rate-limited/unofficial; `nbaRotationHistoryService` already uses a 30-min TTL cache + in-flight dedup — **bulk 3-season backfill throughput unverified**. |
| **Backfill requirement** | Full historical ingestion into immutable `pregame_raw_source_snapshots` + as-of feature rows (§5A.1, §5A.3) required for all three seasons. |

| Season | Player logs | Team/pace | Rotation/role | Tracking (shot/PA/reb-chance) | Scheme/DvP | Class |
| --- | --- | --- | --- | --- | --- | --- |
| Current (2025-26) | R | R | R | U | M | **R/U** |
| Prior-1 (2024-25) | M† | M† | U | U | M | **M/U** |
| Prior-2 (2023-24) | M† | M† | U | U | M | **M/U** |

> **† Player/team logs are `M` (must-build) for prior seasons — a confirmed code
> gap, not merely unverified depth.** `getPlayerGameLogs` / `getTeamGameLogs`
> (`server/services/nbaStatsService.ts:405-424`, `467-486`) accept only
> `{ playerId/teamAbbr, seasonType, limit }` and hard-code
> `const season = getCurrentSeason()` in the request — there is **no season
> parameter**, so a 2024-25 or 2023-24 pull is impossible without first extending
> the adapter. Only the current season is retrievable today.
>
> Downgrade from Current→Prior otherwise reflects that **older-season role-state
> fidelity, tracking coverage, and `knownAt` reconstruction are progressively
> less certain** and must be verified per season, not assumed from the
> current-season adapter.

### 3b. NFL (illustrative window: current 2026 · prior-1 2025 · prior-2 2024)

| Dimension | Value |
| --- | --- |
| **Source** | **None wired.** Requires selecting a canonical NFL data provider (schedule/roster/PBP/snaps/routes/targets/weather). |
| **Granularity** | Needs play-, snap-, route-, target-, carry-level + weather-at-kickoff. |
| **Identifiers** | No canonical NFL id scheme in repo. |
| **`validAt` / `knownAt`** | N/A — no ingestion. |
| **As-of replay suitability** | N/A until ingested. |
| **Rate limits** | Provider-dependent (TBD). |
| **Backfill requirement** | Full 3-season ingestion from scratch. |

| Season | All families | Class |
| --- | --- | --- |
| Current (2026) | M | **M** |
| Prior-1 (2025) | M | **M** |
| Prior-2 (2024) | M | **M** |

---

## 4. Canonical market-semantics audit (launch markets)

Definitions must be pinned to the settlement provider before any grading (§5A.2).

**NBA (§6.1 launch):** `points`, `rebounds`, `assists`, `three_pointers_made`
(official 3PM **incl. OT**), `pts_reb`, `pts_ast`, `reb_ast`, `pra`. Combos are
sums of the same official component definitions. **Push** possible on integer
lines; **OT included** in official markets → the simulation must include OT
(§6A.3). Current NBA path has no explicit pregame push/OT semantics layer.

**NFL (§7.1 launch):** `pass_attempts` (excludes sacks), `completions`,
`passing_yards`, `rushing_attempts` (kneel inclusion **must be confirmed** with
provider), `rushing_yards`, `receptions`, `receiving_yards`. Dropbacks =
attempts + sacks + scrambles (§7A.1). All **M** — no NFL settlement source wired.

**Existing MLB push handling** (reuse pattern): `deriveMoundMarketOutcome`
returns `push` when `actual === line`; DNP/missing → `unavailable` with a
reason code. `persistedPlays` grading (`gradePersistedPlays`) supports
result/void. These are the settlement patterns the new sports mirror — with
sport-owned semantics, never shared math.

---

## 5. Verification owed to PR1 (turns U/R into A)

1. Stand up the as-of feature store (`validAt`/`knownAt`) + leakage firewall.
2. **First extend `getPlayerGameLogs` / `getTeamGameLogs` with an explicit season
   parameter** (they hard-code `getCurrentSeason()` today), then prove a real
   3-season NBA pull per season (depth, `knownAt`, rate-limit throughput) and
   record coverage into `pregame_raw_source_snapshots`.
3. Byte-equivalent live/replay feature fixtures (§9A.3) before any backtest.
4. Select + wire an NFL provider; repeat (2)–(3) for NFL.

Until then, **no coverage row may be promoted to class A**, and no public flag
may claim historical calibration.
