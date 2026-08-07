# PR7A.0 — reviewer summary (analyst adjudication over the machine evidence)

**This file is human adjudication layered on top of the machine-generated evidence in this
directory (`COMPARISON.md`, `GRAMMAR_CROSSCHECK.json`, `PHENOMENA.json`, `FIXTURE_COMPARISON.json`,
`MISMATCHES.json`, `cwevent_output/`). The raw evidence is authoritative; nothing here edits the
fixtures, the contract, or the manifest.** The manifest remains
`draft_pending_toolchain_validation` pending your decision.

## How this was produced

Disposable GitHub Actions workflow (`.github/workflows/pr7a0-chadwick-proof.yml`, Ubuntu), run
`31135930818`, no production secrets, no deploy/DB/Railway/runtime/model change:

- **Parser (pinned):** Chadwick `cwevent` **v0.10.0**, commit
  `8f7e0ecd8984cd752e6aca5deba81b86fb369602` (built from source on the runner).
- **Frozen arguments:** `cwevent -n -y 2019 -f 0,2,3,4,5,6,7,10,11,12,13,14,15,16,17,29,31,33,34,35,36,86,87 <eventfile>`
  (all standard fields; the runbook-named semantic fields — `PITCH_SEQ_TX`, `RESP_BAT_ID`,
  `RESP_BAT_HAND_CD`, `RESP_PIT_ID`, `RESP_PIT_HAND_CD`, `EVENT_CD`, `BAT_LINEUP_ID`, count fields —
  are standard, not extended, in 0.10.0).
- **Source (SHA-verified on a clean runner):** `2019eve.zip`
  `sha256=90160a30231eee80700efa41782136e3ca2cde1bd881fc6c9ade0d9a0fe7b6e9`. Real games:
  `ANA201904040` (interrupted PA), `ARI201908060` / `ARI201909140` / `BAL201908010`
  (two-strike responsible-batter), plus all Angels home games as the grammar population.

## Bottom line per fixture

| Case | Verdict | Action |
|---|---|---|
| 01 normal grammar | **VALIDATED** — frozen token table reproduced cwevent `BALLS_CT`/`STRIKES_CT` on **5561/5561** complete real PAs | none |
| 02 interrupted PA | **Attribution/PA-structure CORRECT; raw-shape defect** | correct raw + reassembly rule (below) |
| 03 responsible batter | **CONFIRMED by real cwevent** (see below); same raw-shape defect as 02 | correct raw + key attribution on `RESP_BAT_ID` |
| 04 handedness split | **CONFIRMED** — 15 switch-hitters resolved to both L and R per event | none |
| 05 missing/incomplete | Adapter completeness policy on top of cwevent (empty `PITCH_SEQ_TX` observed) | none for parser parity |
| 06 unknown handedness | Adapter split-withholding policy (no `?` in sample) | none for parser parity |
| 07 coverage gate | Adapter statistical floor — not a cwevent field | none for parser parity |
| 08 sample floors | Adapter thresholds — not a cwevent field | none for parser parity |

## The two real corrections (both are raw-shape / reassembly, not attribution)

1. **Case 02 & 03 raw continuation must be cumulative, and reassembly reads ONE row.** Real cwevent
   emits the FULL cumulative `PITCH_SEQ_TX` verbatim on the single `BAT_EVENT_FL=T` row and does
   **not** strip the `.` marker. The interrupting event (SB / WP / injury / substitution) is a
   separate `BAT_EVENT_FL=F` row and never a second PA.
   - Fixture 02 currently writes the continuation as `.CX` (non-cumulative) and describes reassembly
     as *concatenating two records*. Correct to: continuation carries the cumulative sequence
     (`BB.CX`); reassembly = take the `BAT_EVENT_FL=T` row's `PITCH_SEQ_TX` and strip non-pitch
     markers (`. + * > 1 2 3 N`); do **not** concatenate across rows.
   - Real interrupted example (`ANA201904040`): the batting event surfaces once as a `T` row with a
     dotted cumulative sequence; the dot-stripped tokens reproduce cwevent's count (12/12 sampled).

2. **Case 03 attribution is RIGHT — read it from `RESP_BAT_ID`.** On every real two-strike carryover,
   cwevent set:
   - `ARI201908060` — `BAT_ID=jonea003`, **`RESP_BAT_ID=dysoj001`** (original), `REMOVED_FOR_PH_BAT_ID=dysoj001`, `EVENT_CD=3` (K), seq `CC.FS`.
   - `ARI201909140` — `BAT_ID=blana002`, **`RESP_BAT_ID=galvf001`**, K, seq `BSBS.C`.
   - `BAL201908010` — `BAT_ID=fishd001`, **`RESP_BAT_ID=gricr001`**, K, seq `CF.BS`.

   This **confirms** fixture 03's `two_strike_substitution_charges_original_batter`: the strikeout is
   charged to the original batter via `RESP_BAT_ID`, while `BAT_ID` is the completing batter. Fixture
   03's `expected` should key attribution on `RESP_BAT_ID` and use the cumulative single-row sequence
   (same as correction 1).

   Note: the automated `COMPARISON.md`/`MISMATCHES.json` verdict for case 03 is conservatively hedged
   (“PARTIAL / adjudicate”) because it only flags rows where `RESP_BAT_ID != BAT_ID` (3 in the
   sample). Those 3 rows ARE the carryovers and they confirm the rule — see
   `PHENOMENA.json → responsibleBatter.respDiffersExamples`.

## Recommendation

The synthetic contract is substantively correct on grammar, handedness, and responsible-batter
attribution. The only real-output corrections are the raw-shape/reassembly representation in cases 02
and 03. Once you approve those fixture edits, `SOURCE_MANIFEST.json` can move
`draft_pending_toolchain_validation → validated` with `parserVersion=Chadwick cwevent 0.10.0
(8f7e0ecd…)` and the frozen `parserArguments` above. **Not done automatically here.**

## Retrosheet attribution

The information used here was obtained free of charge from and is copyrighted by Retrosheet.
Interested parties may contact Retrosheet at www.retrosheet.org.
