# PR6 — NFL Source & Version Manifest (feasibility gate)

Frozen before implementation, per the PR6 source-feasibility gate. **No value in this
document was measured against a live provider** — this environment has no outbound
provider access. Every value that would require a live pull is labeled `PENDING
MEASUREMENT IN THE AUTHORIZED ENVIRONMENT`.

## 1. Source & version manifest

| Field | Value |
| --- | --- |
| Provider | **nflverse** (`nflverse-data` GitHub releases; the data behind `nflreadr`/`nflfastR`). |
| API versioning | nflverse assets are **unversioned per row** but are published as dated GitHub **releases**. We pin a repo-owned `sourceVersion` (`nflverse_weekly_v1` / `nflverse_schedule_v1`) plus the captured CSV `headers[]`, so a provider schema drift (added/removed/reordered columns) is detected rather than silently absorbed. |
| **Operationally ingested by PR6** | **weekly player stats** (feature source) joined to **schedules** (temporal anchor). Rosters/PBP are NOT ingested in PR6 (out of scope). |
| Endpoints used | `player_stats` release → `player_stats_{season}.csv` (per-player-per-week stats); `schedules` release → `games.csv` (game_id, season, week, gameday, home/away team). Exact asset URLs/filenames are pinned in `sourceVersion` and confirmed in the authorized environment. |
| Raw capture path | The runner ingests the **verbatim** provider CSV — original headers/cells, genuine blanks — via a raw fetch that does NOT coerce missing values. So the immutable capture IS the provider payload, and the adapter sees real schema drift and genuine missing values (`null`, never a fabricated `0`). |
| Request == identity | A pull requests the **exact** season + release it stores under; the season and source kind are part of the stable semantic source key. |
| Response shape | CSV with a header row + data rows; one weekly-stats row per (player, season, week); one schedule row per game. |

## 2. Timestamp semantics available from each source (the honesty gate)

nflverse weekly player stats key by **(player, season, week)** and carry **no per-record
game date**; the date is resolved by joining to the **schedule** (`gameday` per
`game_id`/`(season, week, team)`). This governs the `knownAt` contract:

| Timestamp | Availability |
| --- | --- |
| **source-effective** (`sourceEffectiveAt`) | the game's `gameday` (from the schedule join) — a `validAt` anchor, **not** `knownAt`. |
| **source-published / updated** (`sourcePublishedAt`) | the nflverse **release** publish instant, **if** captured from the release metadata; otherwise `null` (explicit, durable unknown). nflverse *can* expose a release timestamp — when available it is persisted, never fabricated. |
| **fetched** (`fetchedAt`) | the instant the CSV body was received AND decoded (the true observation instant → `knownAt`); captured post-decode, never at request start. |
| **ingested** (`ingestedAt`) | the raw snapshot row's immutable `created_at`. |
| `knownAtPolicyVersion` | `nfl_nflverse_knownAt_v1` (persisted). |

### `knownAt` policy (`nfl_nflverse_knownAt_v1`)

- **Forward ingestion** (fetching a completed week's stats going forward): `fetchedAt` is
  an honest upper bound on knowability → `knownAt = fetchedAt`.
- **Historical backfill** (fetching a prior season now): even though nflverse may expose a
  release timestamp, we do **not** back-date `knownAt` to it for leakage-safe replay
  unless a per-record finalize instant is proven; historical box-score `knownAt` is
  therefore **`unsupported`** (a distinct as-of state), never fabricated. `sourcePublishedAt`
  (the release instant) may still be persisted as durable metadata.
- **Never** substitute `gameday` for `knownAt`. **Never** assign a present-day `fetchedAt`
  as a synthetic earlier historical `knownAt`.

## 3. Licensing & production-use assumptions

nflverse redistributes NFL data under its own community terms; NFL trademarks/marks are
not licensed here. **Production use is an owner decision — `PENDING OWNER CONFIRMATION`.**
PR6 commits code + fixtures + a manual runner; it performs **no** live production
ingestion and makes **no** licensing claim.

## 4. Rate-limit & pagination behavior

- **Bulk, no pagination:** each release asset is a **whole-season CSV** — there is no
  pagination cursor. A truncated CSV, a missing asset, or an HTTP failure is an
  **incomplete response** classified as a coverage gap, **never** reported as complete.
- Bulk multi-season throughput is `PENDING MEASUREMENT IN THE AUTHORIZED ENVIRONMENT`.

## 5. Per-source / per-season coverage matrix

Current + two prior seasons kept **separate**. Every cell requires a live pull to measure
and is therefore pending:

| Source | Current season | Prior-1 | Prior-2 | Historical `knownAt` |
| --- | --- | --- | --- | --- |
| `player_stats` (weekly) | `PENDING MEASUREMENT IN THE AUTHORIZED ENVIRONMENT` | `PENDING MEASUREMENT …` | `PENDING MEASUREMENT …` | **unsupported** (no per-record finalize instant) |
| `schedules` | `PENDING MEASUREMENT …` (temporal anchor only, not a feature source) | — | — | n/a |

No measured coverage is fabricated. Live historical ingestion is **not** performed in
this environment; the fixture set + this manifest are the in-repo gate.

## 6. Representative fixtures (committed, SYNTHETIC)

Synthetic, structurally-faithful fixtures (`"synthetic": true`) mirror the nflverse
weekly-stats and schedule CSV shapes and the honest normalized/classified outputs, since
this environment has no nflverse access. They are the in-repo feasibility gate — **not**
captured live payloads.
