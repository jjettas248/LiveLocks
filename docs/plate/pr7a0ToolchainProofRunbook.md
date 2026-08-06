# PR7A.0 — Retrosheet / Chadwick toolchain-parity proof (runbook)

> **Must run in an environment with Retrosheet access.** It cannot run in the agent sandbox:
> the agent proxy denies `www.retrosheet.org:443` (`connect_rejected`, "gateway answered 403 to
> CONNECT (policy denial)"; Retrosheet is not in the proxy `noProxy` allowlist). This is the same
> class of block that moved the Savant zone audit to the Railway/production environment. **No
> validation may be fabricated** — the source manifest stays `draft_pending_toolchain_validation`
> until this proof demonstrates real parity.

## Goal

Prove that the synthetic contract fixtures in
`server/mlb/pregamePowerRadar/hrProbabilityV2/fixtures/retrosheetDiscipline/cases/` match what
Chadwick actually emits from real Retrosheet event files — for a normal PA, an interrupted (period-
separated) PA, and a substitution/responsible-batter PA. Correct the contract/fixtures wherever real
output differs; only then advance the manifest to `validated`.

## Steps

1. **Pin the parser.** Install a specific Chadwick release; record the exact release tag **or** commit
   SHA. (PyPI/`pip` is reachable even in restricted envs; a source build is also fine.)
2. **Freeze the arguments.** Decide and record the exact `cwevent` argument set, e.g.
   `cwevent -y <season> -f <field-list> -x <extended-field-list> <eventfile>`. The extended fields
   MUST include `PITCH_SEQ_TX`, `RESP_BAT_ID`, `RESP_BAT_HAND_CD`, `RESP_PIT_ID`, `RESP_PIT_HAND_CD`,
   `EVENT_CD`, `BAT_LINEUP_ID`, count fields. Confirm `-n` (header) so column identity is explicit.
3. **Download the smallest sample.** Fetch one season event archive (e.g. `2019eve.zip`) from
   Retrosheet. **Preserve the original files unchanged** (keep the raw `.EVN`/`.EVA` + the archive).
4. **Select 1–2 named games** that contain all three phenomena. Do NOT guess game IDs — find them:
   - interrupted PA: `grep -nE '^play,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*\.[^,]*,' *.EV*` (a `.` inside the
     pitch-sequence field = a period-separated continuation).
   - substitution/responsible-batter: a `sub,` record appearing between two `play,` records for the
     same batting slot in the same PA (batter changes mid-AB).
   - normal PA: any complete-sequence `play,` in the same game.
   Record the chosen `GAME_ID`(s).
5. **Capture actual Chadwick output** for the chosen game(s) with the frozen arguments. Save the raw
   CSV output verbatim.
6. **Compare** the real rows against each synthetic case's `expected` block — field identity, pitch-
   sequence reassembly (no double-count across the `.`), responsible-batter attribution, resolved
   handedness codes, and outcome codes.
7. **Correct** the contract (`docs/plate/pr7aPlateDisciplineNoLocationContract.md`) and/or the
   `expected` fixtures wherever real output differs from the synthetic assumption. Note every diff.
8. **Promote the manifest** `SOURCE_MANIFEST.json` `status: draft_pending_toolchain_validation →
   validated`, and fill `parserVersion` + `parserArguments`, **only** after parity is demonstrated.

## Required per-artifact provenance (record for every captured file)

```
source URL or archive name
Retrosheet dataset/version
game ID
download date
file hash (sha256)
Chadwick version/commit
exact parser arguments
output hash (sha256)
```

## Scope guardrails (unchanged)

PR7A.0 is a **1–2 game** proof only. Still NOT authorized: full/multi-season ingestion, the
2000–2025 season matrix job, DB work, production scheduling, feature-envelope TypeScript, evidence-
kind wiring, feature-builder wiring, fitting, PR8, champion/public changes, location/zone proxies,
`starterBullpen`. Retrosheet attribution notice must accompany any captured artifacts (see fixture
README).
