# PR7A — Retrosheet plate-discipline normalization fixtures

**Synthetic raw-shape contract fixtures for `plate_hr_v2_features_v3` (canonical `contactOpportunity`
Retrosheet-backed discipline group + `pitcherDiscipline` group). Contract:
`docs/plate/pr7aPlateDisciplineNoLocationContract.md`.**

```
fixtureOrigin: synthetic
purpose: contract_and_normalization_specification
notValidatedAgainstRealRetrosheetOutput: true
```

These are **hand-authored, synthetic raw-shape contract fixtures** — Retrosheet-*shaped* event
records paired with their **expected-normalized** parse. They were **NOT captured from Retrosheet**
and have **NOT been validated against real Chadwick output**. Nothing here was downloaded. They lock
*expected behavior* for the pitch-sequence grammar, responsible-actor resolution, handedness
resolution, fail-closed completeness, and the floor boundaries — a normalization **specification**,
not evidence that Chadwick emits these fields/values. Real-output parity is proven separately in the
PR7A.0 toolchain proof; until that passes, treat every expected value here as an assumption. No
adapter, feature-builder wiring, ingestion, DB change, or model fitting is authorized yet.

## Retrosheet attribution (required)

> The information used here was obtained free of charge from and is copyrighted by Retrosheet.
> Interested parties may contact Retrosheet at www.retrosheet.org.

Retrosheet permits commercial products based on its data but requires the statement above to appear
prominently. Required placements (recorded now; public display activates only at public promotion,
which PR7A does not do): LiveLocks *Data Sources / About* surface; this repository's dataset README +
evidence-contract docs; and this fixture README.

## Files

- `SOURCE_MANIFEST.json` — frozen semantic crosswalk + executable parser identity.
- `cases/01_normal_game_complete.json` … `cases/08_sample_floor_boundaries.json` — the 8 synthetic
  contract cases. Each pairs `raw` (Retrosheet-**shaped**, synthetic `play,`/`sub,`/`info,` records —
  authored, not captured) with `expected` (the normalized parse the adapter must reproduce, subject
  to PR7A.0 real-output validation).

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
