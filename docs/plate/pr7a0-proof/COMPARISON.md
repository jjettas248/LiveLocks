# PR7A.0 — Chadwick cwevent parity: real-output comparison

- Parser: **Chadwick cwevent 0.10.0** (commit `8f7e0ecd8984cd752e6aca5deba81b86fb369602`)
- Arguments: `cwevent -n -y 2019 -f 0,2,3,4,5,6,7,10,11,12,13,14,15,16,17,29,31,33,34,35,36,86,87 <eventfile>`
- cwevent rows parsed: 6787 (batting-event T rows: 6557)

## Grammar cross-check (frozen token table vs cwevent counts)
- Complete real PAs checked: **5561**, matched cwevent BALLS_CT/STRIKES_CT: **5561** (rate **1**), skipped: 996.

## Fixture verdicts
### 01_normal_game_complete — VALIDATED
frozen token table reproduced cwevent BALLS_CT/STRIKES_CT on 5561/5561 complete real PAs (rate 1).

### 02_interrupted_pa_period — MECHANISM_CONFIRMED_FIXTURE_RAW_DEFECT
930 interrupted batting-event rows observed; interruptions are separate BAT_EVENT_FL=F rows (never a 2nd PA); dot-stripped sequence reproduces the count on 12/12 sampled examples.

**Correction needed:** Fixture 02 raw continuation record is written as '.CX' (non-cumulative) and its note describes reassembly as concatenating two records. Real cwevent emits the FULL cumulative sequence verbatim on the single BAT_EVENT_FL=T row (e.g. 'BB.CX') and does not strip the dot. Correction: (a) raw continuation must be cumulative; (b) reassembly rule = take the BAT_EVENT_FL=T row's PITCH_SEQ_TX and strip non-pitch markers — do NOT concatenate across rows; (c) the interrupting event is a distinct BAT_EVENT_FL=F row.

### 03_sub_responsible_batter — PARTIAL_RESP_DIFFERS_EXISTS
dotted-strikeout rows: 241; T rows where RESP_BAT_ID != BAT_ID: 3.

See respDiffersExamples / dottedStrikeoutExamples for the actual attribution; adjudicate against fixture 03.

### 04_handedness_split — MECHANISM_CONFIRMED
15 batters resolved to BOTH L and R across PAs (switch-hitter per-event resolution), confirming RESP_BAT_HAND_CD/RESP_PIT_HAND_CD are resolved per event, not copied from the roster line.

### 05_missing_incomplete_seq — ADAPTER_LOGIC_WITH_CWEVENT_INPUT
cwevent emits empty PITCH_SEQ_TX for no-pitch PAs (0 T rows with empty sequence observed). Uncountable-token exclusion (U/K) and the coverage denominator are ADAPTER completeness policy applied on top of cwevent output, not fields cwevent emits.

### 06_unknown_handedness — ADAPTER_LOGIC_ONLY
No '?' handedness rows in the sampled games; split-withholding is adapter policy layered on cwevent output.

### 07_below_coverage_gate — ADAPTER_LOGIC_ONLY
Sequence-coverage gate is a statistical aggregation rule over many PAs; not a cwevent field. Out of scope for parser parity (no correction implied by real output).

### 08_sample_floor_boundaries — ADAPTER_LOGIC_ONLY
Sample-floor present/null boundaries are adapter thresholds; not a cwevent field. Out of scope for parser parity.

## Actionable mismatches
- **02_interrupted_pa_period** — raw_shape_and_reassembly_rule
- **03_sub_responsible_batter** — responsible_batter_attribution

_Manifest stays `draft_pending_toolchain_validation`; this bundle is evidence for human review, not an auto-promotion._
