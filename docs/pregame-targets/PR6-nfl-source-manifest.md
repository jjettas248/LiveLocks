# PR6 — NFL Source & Version Manifest (frozen)

The exact upstream sources below were **recovered from the authoritative nflverse/nflreadr
open-source loaders and verified against the real files**. They are frozen here (no
"to be confirmed" placeholders). No live production pull is performed by PR6.

## 1. Frozen source manifest

### 1a. Weekly player stats (feature source)

| Field | Value |
| --- | --- |
| Repository | `nflverse/nflverse-data` (GitHub releases) |
| Release/tag | `stats_player` |
| Asset (per season) | `stats_player_week_{season}.csv` |
| Exact URL | `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_{season}.csv` |
| Source version | `nflverse_stats_player_week_v1` |
| Content type | `text/csv` (served `application/octet-stream`) |
| Required headers | `player_id`, `game_id`, `season`, `week`, `season_type`, `team` |
| Also consumed | `opponent_team`, `position`, `targets`, `receptions`, `receiving_yards`, `carries`, `rushing_yards` |
| Game identity | provider-native **`game_id`** (e.g. `2024_01_SF_KC`) — canonical game identity, never reconstructed |

### 1b. Schedules (temporal anchor + cross-check)

| Field | Value |
| --- | --- |
| Repository | `nflverse/nfldata` |
| Path | `data/games.csv` (multi-season, 2006+) |
| Exact URL | `https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv` |
| Source version | `nflverse_nfldata_games_v1` |
| Content type | `text/csv` |
| Required headers | `game_id`, `season`, `week`, `gameday` |
| Also consumed | `home_team`, `away_team`, `game_type` |
| Note | `load_schedules()` reads the R-serialized `games.rds`; PR6 uses the equivalent CSV mirror `data/games.csv` (same dataset) since the pipeline parses CSV. |

The weekly row is JOINED to the schedule **BY `game_id`**; the schedule supplies only the
calendar anchor (`gameday`) and cross-checks (season/week/home/away). A join is failed
closed on: no matching `game_id`, season mismatch, week mismatch, or a team/opponent that
contradicts the matched game.

## 2. Timestamp semantics (the honesty gate)

| Timestamp | Availability |
| --- | --- |
| **source-effective** (`sourceEffectiveAt`) | schedule `gameday` (via the game_id join) — a `validAt` anchor, not `knownAt`. |
| **source-published** (`sourcePublishedAt`) | the response `Last-Modified` instant if present (guarded against a malformed header), else `null` (durable unknown) — never fabricated. |
| **fetched** (`fetchedAt`) | the instant the CSV body was received AND decoded (→ `knownAt`); captured post-decode, never at request start. |
| **ingested** (`ingestedAt`) | the raw snapshot's immutable `created_at`. |
| `knownAtPolicyVersion` | `nfl_nflverse_knownAt_v1` (persisted). |

**`knownAt` policy (`nfl_nflverse_knownAt_v1`):** forward ingestion → `knownAt = fetchedAt`
(honest upper bound). Historical backfill → `knownAt` is **`unsupported`** (nflverse exposes
no per-record finalize instant); `sourcePublishedAt` may still be persisted as metadata.
`gameday` is never substituted for `knownAt`; a present-day `fetchedAt` is never back-dated.

## 3. Licensing & production-use

- **nflverse-data license:** the `nflverse-data` repository is published under **CC BY 4.0**.
  Downstream use must **attribute nflverse** (e.g. "Data via the nflverse project,
  CC BY 4.0"). `nfldata` (schedules) is likewise community-maintained nflverse data.
- **NFL trademark / affiliation disclaimer:** NFL team names, logos, and marks are
  trademarks of the National Football League; this project is **not affiliated with or
  endorsed by the NFL**. No NFL marks are redistributed here — only statistical data.
- **PRODUCTION USE: `PENDING OWNER CONFIRMATION`.** The owner has not authorized production
  ingestion. PR6 commits code + synthetic fixtures + a manual runner; it performs **no**
  live production ingestion, enables **no** ingestion flag, and activates **no** entitlement.

## 4. Rate-limit & pagination

Each asset is a **whole-file** CSV (weekly = one season; schedule = all seasons) — no
pagination cursor. A truncated/missing/HTTP-failed response is an **incomplete** coverage
gap, never reported complete. Bulk multi-season throughput is
`PENDING MEASUREMENT IN THE AUTHORIZED ENVIRONMENT`.

## 5. Per-season coverage matrix

Current + two prior seasons kept **separate**. Every live cell requires a real pull and is
pending. Coverage reporting spans the full pipeline (raw → structurally-accepted →
schedule-resolved → feature-bearing → persisted); a weekly parse is never counted as usable
coverage when the schedule join drops rows.

| Source | Current | Prior-1 | Prior-2 | Historical `knownAt` |
| --- | --- | --- | --- | --- |
| `stats_player_week` | `PENDING MEASUREMENT …` | `PENDING MEASUREMENT …` | `PENDING MEASUREMENT …` | **unsupported** |
| `nfldata/games.csv` | `PENDING MEASUREMENT …` (anchor only) | — | — | n/a |

## 6. Fixtures (committed, SYNTHETIC)

Synthetic-but-upstream-faithful fixtures (`__fixtures__/`, `"synthetic": true`) mirror the
real weekly + schedule CSV schemas and the honest normalized/classified outputs — **not**
captured live payloads (no nflverse access in this environment). If live captured fixtures
become available later, they are kept distinguished from synthetic ones.
