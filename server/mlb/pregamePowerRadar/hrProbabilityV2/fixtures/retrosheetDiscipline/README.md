# PR7A — Retrosheet plate-discipline normalization fixtures

**Frozen representative fixtures for `plate_hr_v2_features_v3` (canonical `contactOpportunity`
Retrosheet-backed discipline group + `pitcherDiscipline` group). Contract:
`docs/plate/pr7aPlateDisciplineNoLocationContract.md`.**

These are **hand-authored, representative** raw Retrosheet event records paired with their
**expected-normalized** parse. They are **not ingested data** — nothing here was downloaded from a
network source. They exist to lock the pitch-sequence grammar, responsible-actor resolution,
handedness resolution, fail-closed completeness, and the floor boundaries **before** any adapter is
written. No adapter, feature-builder wiring, ingestion, DB change, or model fitting is authorized yet.

## Retrosheet attribution (required)

> The information used here was obtained free of charge from and is copyrighted by Retrosheet.
> Interested parties may contact Retrosheet at www.retrosheet.org.

Retrosheet permits commercial products based on its data but requires the statement above to appear
prominently. Required placements (recorded now; public display activates only at public promotion,
which PR7A does not do): LiveLocks *Data Sources / About* surface; this repository's dataset README +
evidence-contract docs; and this fixture README.

## Files

- `SOURCE_MANIFEST.json` — frozen semantic crosswalk + executable parser identity.
- `cases/01_normal_game_complete.json` … `cases/08_sample_floor_boundaries.json` — the 8 authorized
  fixtures. Each pairs `raw` (Retrosheet `play,`/`sub,`/`info,` records) with `expected` (the
  normalized parse the adapter must reproduce).

## Pitch-sequence token classification (frozen)

| Class | Tokens |
|---|---|
| Ball | `B` `I` `V` (`P` if taken) |
| Called strike | `C` |
| Swing — whiff | `S` `M` |
| Swing — foul (contact, not in play) | `F` `T` `L` `O` `R` |
| Swing — in play | `X` `Y` |
| Hit by pitch | `H` |
| Non-pitch markers (stripped, never counted) | `.` `+` `*` `>` `1` `2` `3` `N` |
| Uncountable (fail completeness) | `U` `K` |

`.` additionally marks a **plate appearance that spans multiple play records** (an interruption such
as a stolen base mid-AB): the continuation record's sequence begins with `.` denoting the pitches
already recorded — reassemble to one PA, **never double-count, never treat as malformed**.

## Floors (capture-usability, not final modeling thresholds)

Sequence coverage ≥ 0.90 · batter ≥ 150 PA · pitcher ≥ 300 BF · batter hand-split ≥ 75 PA ·
pitcher hand-split ≥ 150 BF. Below a floor → the affected rate is `null` with an explicit reason;
raw counts are always preserved so PR8 can test alternative thresholds.
