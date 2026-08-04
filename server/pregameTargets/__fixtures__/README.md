# PR0 Golden Fixtures — Boundary Coverage Ledger

Freezes the **current observable behavior** of the pure engine / scoring /
grading / mapping / serialization functions the NBA + NFL Pregame Targets
program (`docs/pregame-targets/`) builds on. **Non-production-change baseline**:
nothing here is imported by production code; no production file was modified.

- **Runner:** `server/pregameTargets/goldenFixtures.test.ts`
- **Verify:** `npx tsx server/pregameTargets/goldenFixtures.test.ts`
- **Re-record (only when a change is intentional):** `GOLDEN_RECORD=1 npx tsx …`
- **Inputs** are committed deterministic literals (test + `signalFactories.ts`,
  the latter fully `tsc`-typed). **Outputs** are the committed `*.json` files.
  The runner recomputes and asserts byte-equality.

All fixtures are time-frozen (no `Date.now()`; volatile timestamp fields
normalized to `"<volatile>"`), canonically key-sorted, privacy-safe (synthetic
ids only), and independent of network/credentials. Persistence mapping runs
behind a **fixed, unreachable dummy `DATABASE_URL`** solely to pass an import
guard — **no database is contacted and no query is issued** (node-postgres
connects lazily; the pure mapping never queries).

## Classification of every requested boundary

Each is exactly one of: **[COVERED]** committed fixture · **[UNCOVERED-DET]**
deterministic current behavior left uncovered, with reason · **[NOT-REPR]** not
representable by current code · **[NEEDS-EXTERNAL]** requires DB / credentials /
network / live data.

| Requested boundary | Class | Where / why |
| --- | --- | --- |
| Serialized Plate output via `buildResponse` | **[COVERED]** | `plateBuildResponse.json` (public-only + include-suppressed) |
| Serialized Mound output via `buildMoundResponse` | **[COVERED]** | `moundBuildResponse.json` (public-only + include-research; settlement view stamped) |
| Plate `signalToRow → rowToSignal` | **[COVERED]** | `platePersistenceMapping.json` (row→signal + signal→row round-trip) |
| Mound `signalToRow → rowToSignal` | **[COVERED]** | `moundPersistenceMapping.json` |
| Plate grading / win attribution | **[COVERED]** | `plateWinAttribution.json` (`deriveWinAttribution`: hit/miss, public/not, first-AB, third-AB, unknown-first-AB) |
| NBA zero-sample (`recentGameCount: 0`) | **[COVERED]** | `nbaComputeProbability.json` → `zero_sample_recent0` (plus `low_sample_recent2`) |
| NBA final probability + engine wrapper | **[COVERED]** | `nbaFinalize.json`, `nbaComputeProbability.json`, `nbaEngineWrapper.json` |
| MLB Plate & Mound scoring/tier, Mound direction | **[COVERED]** | `mlbPlateScoring.json`, `mlbMoundScoring.json`, `mlbMoundDirection.json` |
| Mound grading (push / DNP / missing / correction) | **[COVERED]** | `mlbMoundGrading.json` |
| Stale timestamps | **[COVERED]** (as canonical timestamps) | `oddsAgeSec` drives `finalizeNbaProbability` freshness (`nbaFinalize.json` → `stale_odds_gate`); wall-clock stamps normalized to `<volatile>` |
| Role changes | **[COVERED]** | `role_uncertain` / `role_uncertain_cap` (`nbaFinalize`, `nbaComputeProbability`); Plate/Mound coverage-cap cases |
| Injury / availability uncertainty | **[UNCOVERED-DET]** at engine level → **[NOT-REPR]** as scenario tree | Current NBA/MLB pregame code has **no** scenario-weighted availability model (spec §6.3/§6A.2). The closest deterministic proxy — pregame minutes under absence — lives in `minutesProjectionService`, which requires live inputs → **[NEEDS-EXTERNAL]**. Documented as a PR3+ gap, not fabricated. |
| Floating-point precision | **[COVERED]** | Numbers recorded EXACTLY (no rounding) in every group, so precision drift fails the guard |
| Null behavior | **[COVERED]** | `missing_assist_rates`, `filters_invalid` (null line/prob/edge), Mound grading null-final / null-line / null-direction |
| Deterministic ordering | **[COVERED]** | `nbaEngineWrapper.json` → `ordering_multi`; `buildResponse`/`buildMoundResponse` sort by `score10` |
| Canonical timestamps | **[COVERED]** | `canonicalize.ts` normalizes `timestamp/dataFreshness/createdAt/generatedAt/settledAt`; `Date` → ISO string |
| Ledger mapping | **[COVERED]** | Plate/Mound `signalToRow`/`rowToSignal` round-trips (above) |
| DB round-trip (through a real database) | **[NEEDS-EXTERNAL]** | `loadPregameSnapshotFromDb` / `loadMoundSnapshotFromDb` + `storage.upsert*` issue real SQL. The **pure mapping** either side of the DB is COVERED; the DB I/O itself needs Postgres (a `*.pg-integration.test.ts`, PR2). |
| Live grading feeds | **[NEEDS-EXTERNAL]** | `gradePregameOutcomes` / `gradeMoundOutcomes` read live box-score/play-by-play + storage. Only the pure outcome-derivation math is frozen (`mlbMoundGrading.json`). |

## Other boundaries not captured (require external services / a full build)

- **Full build pipelines** `buildPregamePowerRadar()` / `buildMlbMoundRadar()`
  — live game discovery, lineups, weather, odds (network + DB). **[NEEDS-EXTERNAL]**
- **Live decision / odds layer** — canonical line selection, freshness,
  calibrator promotion. **[NEEDS-EXTERNAL]**
- **NFL** — entirely greenfield; nothing to freeze yet. **[NOT-REPR]**

Update this table if you extend the fixtures, so the ledger never overstates
what is actually verified.
