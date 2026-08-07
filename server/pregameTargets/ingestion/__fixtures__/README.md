# PR5 NBA ingestion fixtures — case ledger

Nine representative fixtures — in `cases.json` (`{ headers, cases: [{ id, description,
kind, season, entityNativeId, fetchedAtIso, raw, expected }] }`) — freeze the raw NBA
Stats `playergamelog` / `teamgamelog` response shapes and the **expected normalized +
as-of classification** for each case. They are the in-repo feasibility gate (no live
provider access in this sandbox — see `docs/pregame-targets/PR5-source-manifest.md`).
`raw` mirrors the provider's `{ resultSets: [{ headers, rowSet }] }`; `expected` is the
honest result the adapter/feature-builder/coverage layer must produce. `fixtures.test.ts`
validates every case against the real pipeline.

| # | `cases.json` id | Case | Honest classification the fixture locks |
| --- | --- | --- | --- |
| 1 | `current_season` | Current-season player logs | Normal value-bearing rows; forward `knownAt = fetchedAt` (honest). |
| 2 | `prior1_season` | Prior-1 season player logs (explicit `season` arg) | Rows ingested; **historical `knownAt` = `unsupported`** (source exposes no publish instant). |
| 3 | `prior2_season` | Prior-2 season player logs (explicit `season` arg) | Same as #2 — prior season, historical `knownAt` unsupported. |
| 4 | `traded_player` | Traded player (two team tricodes within one season via `MATCHUP`) | Both stints ingested, neither dropped nor merged. |
| 5 | `team_change` | Team-level identity change (franchise tricode) via `teamgamelog` | Ingested under its own canonical id; not coalesced with a different franchise. |
| 6 | `missing_game` | A provider-omitted stat (`FG3M` null) | Omission → `missing`, **never** `observed_zero` and never fabricated. |
| 7 | `observed_zero` | Player appeared but recorded 0 of a stat | `observed_zero` (finite 0), **distinct** from `missing`. |
| 8 | `corrected_record` | Same game re-fetched with a corrected stat value | A genuine content change → a **new immutable snapshot** (different content hash); the prior snapshot is retained; replay before the correction still sees the old value. |
| 9 | `provider_incomplete` | Provider failure / truncated / empty `resultSets` | Incomplete → coverage gap; **cannot** be reported as complete coverage and **cannot** fabricate a zero or a full feature. |
| 10 | `reordered_headers` | Columns in a different order | Resolved **by name**; parses correctly (order-independent). |
| 11 | `missing_required_header` | Missing `GAME_DATE` | Fail closed → `incomplete_response` (a structural anchor is required). |
| 12 | `duplicate_required_header` | Duplicate `GAME_ID` | Ambiguous → fail closed → `incomplete_response` (never silent last-wins). |
| 13 | `same_content_different_games` | Identical stat content, distinct `GAME_ID`s | Different content hash → no identity collision (game id is in the hashed payload). |

**Synthetic, not captured:** these fixtures are hand-authored to be structurally faithful to the endpoint shape; they are **not** captured live NBA Stats payloads (`cases.json` carries `"synthetic": true`).

## Honesty rules these fixtures enforce (from the PR5 scope lock)

- `missing`, `observed_zero`, `stale`, `unsupported`, `disagreement`, `imputed` remain **distinct** as-of states — never collapsed.
- A present-day `fetchedAt` is **never** written as a synthetic historical `knownAt`; `GAME_DATE` is **never** substituted for `knownAt`.
- Identical `(source identity, effective timestamp, source version, content hash)` re-ingestion is a **no-op** (no duplicate, no rewrite). A genuine correction creates a new linked snapshot.
- A provider failure or partial page can never become a `0` or a "complete" coverage claim.
- No line / price / book / EV / settlement outcome / future information appears anywhere in these fixtures or their normalized outputs — the projection-core input construction stays blind.
