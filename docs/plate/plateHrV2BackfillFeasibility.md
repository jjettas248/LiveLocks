# Plate HR V2 — As-Of Backfill Feasibility & Decision (PR2)

> Per plan §7.1 + §12 PR2: decide whether historical **as-of** prediction snapshots can
> be faithfully reconstructed. **Rule:** if the point-in-time inputs a prediction needed
> cannot be recreated as they existed before first pitch, **do NOT backfill** — rely on
> forward capture (PR3) and wait for adequate outcomes. Never claim a "frozen input" that
> did not actually exist as-of.

## What a training-eligible PredictionSnapshot requires (recap)

Every referenced `SourceEvidenceSnapshot` must satisfy its evidenceKind rule, with
`availableAt ≤ predictionAsOf ≤ firstPitch` (plan §7.1). The prediction bundles, per
batter-game and moment: historical stats, the **confirmed lineup**, the **probable
pitcher**, the **weather forecast**, and park — each **as it was known before first pitch**.

## Reconstructability, source by source

| Source | Reconstructable as-of a past date? | Why |
|---|---|---|
| Historical Statcast stats (batter/pitcher, by pitch type/hand) | **Partially yes** | Savant `type=details` is date-boundable (`game_date_gt/lt`), so season-to-date-**through-a-past-date** aggregates can be recomputed. `dataThroughAt` is honest (the query's upper bound). |
| Confirmed lineup (batting order slot) | **No** | The MLB Stats API returns the game's *final* lineup, not "the lineup as posted/known at the 6am-ET slate build." Late scratches/optimizations are not time-stamped historically. |
| Probable pitcher | **No (reliably)** | Probables change; historical "probable as known at prediction time" is not archived — only the pitcher who actually started is recoverable. |
| Weather forecast | **No** | Open-Meteo does not archive the *forecast issued at a past time*; only observed history / a fresh forecast is available. A backfilled weather value would be observed-after-the-fact → `availableAt > predictionAsOf` → excluded by §7.1. |
| Park / fence geometry | **Yes** | Static/seasonal. |

## Decision

**No full-snapshot historical backfill.** Lineup, probable, and weather-forecast state
cannot be faithfully reconstructed as-of, and a prediction snapshot that mixes real
historical stats with fabricated/observed-after lineup/probable/weather would violate
§7.1 (and would silently leak). Therefore:

1. **Primary path: forward capture (PR3).** Capture real as-of snapshots going forward and
   accrue graded outcomes until the §22 frozen minimum sample is met, *then* fit/calibrate (PR8).
2. **No backfilled PredictionSnapshots** are written. Any historically-derived stat
   aggregate that is ever used for research must be marked `reconstructed = true` and is
   **excluded** from training/labels unless a provider offering **verified reproducible
   as-of retrieval** is adopted (none is today).
3. **Optional, clearly-separated:** a stats-only retrospective (historical Statcast +
   actual starter + observed weather) may be built later purely for **descriptive
   exploration** — it is explicitly **not** an as-of backtest and can never feed the
   promotion gates. Not in scope now.

## Consequence for the timeline

Promotion (PR8+) is **gated on forward-capture volume**, not on a backfill shortcut. The
§22 gate spec's minimum slate-days / games / batter-games / HR-positive outcomes must
accrue from real captured snapshots before the Test set is opened.
