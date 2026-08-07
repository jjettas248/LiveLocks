# PR7A — Retrosheet plate-discipline normalization fixtures

**Raw-shape + normalization contract fixtures for `plate_hr_v2_features_v3` (canonical
`contactOpportunity` Retrosheet-backed discipline group + `pitcherDiscipline` group). Contract:
`docs/plate/pr7aPlateDisciplineNoLocationContract.md`.**

```
purpose: contract_and_normalization_specification
parser:  Chadwick cwevent 0.10.0 (commit 8f7e0ecd8984cd752e6aca5deba81b86fb369602)
proof:   docs/plate/pr7a0-proof/  (PR7A.0 real-Retrosheet toolchain parity, GitHub Actions run 31135930818)
```

## Validation status (PR7A.0 proved parity; PR7A.1 reconciled the raw shape)

The PR7A.0 toolchain proof ran the **pinned** Chadwick `cwevent` over **real, SHA-verified** 2019
Retrosheet event files on a clean runner and captured actual output (`docs/plate/pr7a0-proof/`). What
that proof established, and how these fixtures now stand:

- **Pitch-sequence grammar (case 01) — VALIDATED.** The frozen token table below reproduced cwevent's
  own `BALLS_CT`/`STRIKES_CT` on **5561/5561** complete real plate appearances (rate 1.0).
- **Interrupted PA (case 02) — REAL-ANCHORED & VALIDATED.** Re-anchored to a real cwevent output row
  (`forsl001`, `ANA201904040`, `PITCH_SEQ_TX '.BBCX'`). See the corrected raw shape below.
- **Responsible batter (case 03) — REAL-ANCHORED & VALIDATED.** Re-anchored to a real two-strike
  carryover (`jonea003` completes for `dysoj001`, `ARI201908060`, `CC.FS`, K). Real cwevent charges
  the strikeout to the **original** batter via `RESP_BAT_ID`, with `BAT_ID` = completing batter and
  `REMOVED_FOR_PH_BAT_ID` = original — confirming the fixture's attribution rule.
- **Handedness split (case 04) — MECHANISM CONFIRMED.** Real switch-hitters resolve to both L and R
  per event (handedness is per-event, not copied from the roster line).
- **Cases 05–08 — adapter-policy specifications (not parser-emitted).** Fail-closed completeness,
  unknown-handedness split-withholding, the coverage gate, and the sample floors are **adapter**
  policies layered on cwevent output, not fields Chadwick emits. The PR7A.0 proof found nothing in
  real output that contradicts them; they remain contract specifications for the (still-unauthorized)
  adapter.

Every case passes the **revised contract comparison** (`scripts/pr7a0/verifyFixtureContract.mjs` →
`CONTRACT_COMPARISON_RESULT.json`): each declared discipline field is recomputed from the frozen
token table, and the real-anchored cases (02, 03) are matched byte-for-byte against the committed
proof CSVs.

Still **provisional / pending** (unchanged by PR7A.1): the **2000+ training floor** remains
`provisional_not_empirically_verified`, and the **2000–2025 season matrix** remains
`PENDING_MEASUREMENT`. No adapter, feature-builder wiring, ingestion, DB change, scheduling, evidence
wiring, or model fitting is authorized.

## Retrosheet attribution (required)

> The information used here was obtained free of charge from and is copyrighted by Retrosheet.
> Interested parties may contact Retrosheet at www.retrosheet.org.

Retrosheet permits commercial products based on its data but requires the statement above to appear
prominently. Required placements (recorded now; public display activates only at public promotion,
which PR7A does not do): LiveLocks *Data Sources / About* surface; this repository's dataset README +
evidence-contract docs; and this fixture README. Only minimal source excerpts, hashes, and proof
outputs are committed — never the full Retrosheet archive or a full-season CSV.

## Files

- `SOURCE_MANIFEST.json` — semantic crosswalk + **pinned** executable parser identity + toolchain-proof
  provenance (archive/eventfile/output hashes, run id). Status: `validated`.
- `CONTRACT_COMPARISON_RESULT.json` — output of the revised contract comparison (all 8 cases PASS).
- `cases/01_normal_game_complete.json` … `cases/08_sample_floor_boundaries.json` — the 8 contract
  cases. Cases 02 & 03 carry `fixtureOrigin: real_retrosheet_chadwick_v0_10_0` and a
  `validatedAgainstProof` block; cases 01 & 04–08 remain contract specifications
  (`fixtureOrigin: synthetic`) whose behavior the proof validated (01/04) or found out-of-scope for
  parser parity (05–08).

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

### Interruption `.` marker — validated raw shape (PR7A.0)

`.` marks a **plate appearance that spanned multiple event-file play records** (an interruption such
as a stolen base, wild pitch, injury, or substitution mid-AB). In **actual Chadwick cwevent output**
the completed PA surfaces as **ONE `BAT_EVENT_FL=T` row whose `PITCH_SEQ_TX` carries the FULL
CUMULATIVE sequence with the `.` preserved verbatim** (e.g. `.BBCX`, `CC.FS`, `BCBB.CX`) — cwevent
does **not** strip the dot. The interrupting event is a **separate `BAT_EVENT_FL=F` row** and is
**never** a second PA. Normalization therefore **reads the single terminal row and strips the `.`
marker in one pass** (`.BBCX` → `[B,B,C,X]`); it **must not** concatenate pitch fragments from
separate records (there is no second batting-event row to concatenate). A two-strike substitution
attributes via `RESP_BAT_ID` (original/responsible batter), with `BAT_ID` the completing batter.

## Floors (capture-usability, not final modeling thresholds)

Sequence coverage ≥ 0.90 · batter ≥ 150 PA · pitcher ≥ 300 BF · batter hand-split ≥ 75 PA ·
pitcher hand-split ≥ 150 BF. Below a floor → the affected rate is `null` with an explicit reason;
raw counts are always preserved so PR8 can test alternative thresholds.
