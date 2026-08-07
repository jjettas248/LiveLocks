# PR5 — NBA Source & Version Manifest (feasibility gate)

Frozen before implementation, per the PR5 source-feasibility gate. **No value in this
document was measured against a live provider** — this sandbox has no `DATABASE_URL`,
no NBA Stats access, and no outbound provider access. Every value that would require a
live pull is labeled `PENDING MEASUREMENT IN THE AUTHORIZED ENVIRONMENT`.

## 1. Source & version manifest

| Field | Value |
| --- | --- |
| Provider | NBA Stats (`stats.nba.com`), **unofficial/undocumented** endpoints, via `server/services/nbaStatsService.ts` |
| API versioning | NBA Stats endpoints are **unversioned**. We pin a repo-owned `sourceVersion` string per adapter (`nba_stats_gamelog_v1`) plus the captured response `headers[]` array, so a provider schema drift (added/removed/reordered columns) is detected rather than silently absorbed. |
| **Operationally ingested by PR5** | **`playergamelog` ONLY.** The ingestion job + runner fetch and persist player game logs. `teamgamelog` received **season-plumbing support only** (an optional `season` param on `getTeamGameLogs`, for a future scoped consumer) — there is **no** team ingestion job in PR5 and no team snapshot is written. Team feature ingestion is deliberately out of scope pending explicit approval. |
| Raw capture path | The runner ingests the **verbatim** provider JSON via `fetchRawNbaPlayerGameLog` (`server/services/nbaStatsService.ts`) — NOT the presentation `getPlayerGameLogs()`/`PlayerGameLogRow` path, which drops response metadata and coerces missing `MIN`/`PTS` to `0`. So the immutable snapshot IS the provider payload, and the adapter sees real schema drift (missing/duplicate headers) and genuine missing values (`null`, not a fabricated `0`). The captured `headers[]` therefore reflect the true provider schema. |
| Request == identity | A pull requests the **exact** `Season` label and `SeasonType` it stores under; `SeasonType` is restricted to `Regular Season`/`Playoffs` and forwarded verbatim, so regular-season rows can never be stored under a Playoffs identity (or vice-versa). |
| Response shape | `resultSets[0]` with `headers: string[]` + `rowSet: any[][]`; one row per game, most-recent-first. |

## 2. Timestamp semantics available from each source (the honesty gate)

`playergamelog`/`teamgamelog` expose **`GAME_DATE` only** — there is **no per-record
published / finalized / last-updated timestamp**. This governs the `knownAt` contract:

| Timestamp | Availability from these endpoints |
| --- | --- |
| **source-effective** (`sourceEffectiveAt`) | `GAME_DATE` — the game's calendar date. This is *when the stat became true* (a `validAt` anchor), **not** `knownAt`. |
| **source-published / updated** (`sourcePublishedAt`) | **NOT EXPOSED.** The endpoint returns no publish/finalize/update instant. |
| **fetched** (`fetchedAt`) | Real wall-clock time of our request. |
| **ingested** (`ingestedAt`) | Real wall-clock time of our DB write. |
| **computed `knownAt`** | See policy below. |
| `knownAtPolicyVersion` | `nba_gamelog_knownAt_v1` (documents the rule that produced `knownAt`). |

### `knownAt` policy (`nba_gamelog_knownAt_v1`)

- **Forward ingestion** (fetching a game's completed box score shortly after it finishes, going forward): `fetchedAt` is an honest upper bound on knowability and is used as `knownAt`. Honest because we genuinely first observed it then.
- **Historical backfill** (fetching a prior-season box score **now**): the source exposes **no** publish timestamp, and `fetchedAt` is a *present-day* instant (e.g. 2026) that is **not** an honest historical `knownAt` for a 2024 game, while `GAME_DATE` is forbidden as a `knownAt` substitute. Therefore **historical box-score `knownAt` is `unsupported`** for leakage-safe replay from this source: the feature/source is classified `unsupported` (a distinct as-of state), never given a fabricated `knownAt`.
- **Never** substitute `GAME_DATE` for `knownAt`. **Never** assign a present-day `fetchedAt` as a synthetic earlier historical `knownAt`. Equal-to-prediction instants follow the existing PR1 firewall contract (`knownAt <= predictionAt`, with the PR1 tie-break).

**Consequence, stated plainly:** with only `playergamelog`/`teamgamelog`, honest *historical* as-of replay of prior-season box-score features is **not source-supported**; those rows are ingested (raw snapshot + source-effective/fetched/ingested preserved) but marked `unsupported` for historical `knownAt`. A leakage-safe historical backfill would require a source that publishes a per-record finalize/publish instant — a provider-selection question flagged here, not silently resolved.

## 3. Licensing & production-use assumptions

- NBA Stats endpoints are **unofficial and undocumented**; no commercial/redistribution license is asserted here. **Production use is an owner decision** — `PENDING OWNER CONFIRMATION`. PR5 commits code + fixtures + a manual runner; it performs **no** live production ingestion and makes **no** licensing claim.

## 4. Rate-limit & pagination behavior

- **Rate limits:** aggressively rate-limited/unofficial; the existing service already caches game logs (`GAME_LOGS_TTL`) and rotates keys. Bulk 3-season throughput is `PENDING MEASUREMENT IN THE AUTHORIZED ENVIRONMENT`.
- **Pagination:** `playergamelog`/`teamgamelog` return the **entire** season in a single `resultSets[0].rowSet` — there is **no** pagination cursor. A truncated `rowSet`, a missing `resultSets`, or an HTTP failure is therefore an **incomplete response** and is classified as a coverage gap (`missing` / `incomplete`), **never** reported as complete coverage. Deterministic behavior is verified in the fixtures.

## 5. Per-source / per-season coverage matrix

The temporal contract keeps current + two prior seasons **separate**. Every cell below
requires a live pull to measure and is therefore pending:

| Source | Current season | Prior-1 | Prior-2 | Historical `knownAt` |
| --- | --- | --- | --- | --- |
| `playergamelog` | `PENDING MEASUREMENT IN THE AUTHORIZED ENVIRONMENT` | `PENDING MEASUREMENT IN THE AUTHORIZED ENVIRONMENT` | `PENDING MEASUREMENT IN THE AUTHORIZED ENVIRONMENT` | **unsupported** (source exposes no publish instant) |
| `teamgamelog` | **NOT INGESTED BY PR5** (season-plumbing only; no team ingestion job) | — | — | n/a — not ingested |

No measured three-season coverage matrix is fabricated. Live historical ingestion is
**not** performed in this sandbox; the fixture set + this manifest are the in-repo gate.

## 6. Representative fixtures (committed)

**Thirteen** representative **synthetic** raw fixtures (`cases.json` carries
`"synthetic": true`) + expected normalized outputs live in
`server/pregameTargets/ingestion/__fixtures__/`, covering: current season, each prior
season, a traded player, a team change, a missing game, an observed zero, a corrected
source record, a provider failure / incomplete response, reordered headers, a missing
required header, a duplicate required header, and identical content in two different
games (no identity collision). They are hand-authored to be structurally faithful to
the endpoint shape — **not** captured live payloads (no NBA Stats access in this
sandbox). See that directory's `README.md` for the case ledger and the honesty
classification of each.
