# MLB GUARDRAIL AGENT

## OBJECTIVE
Detect drift in MLB engine behavior between deploys and emit
`[MLB_DRIFT_WARNING]` when guardrail thresholds are crossed.

## DRIFT SIGNALS TRACKED

| Signal | Source | Snapshot field |
|---|---|---|
| Surfaced play count | per-cycle qualified count | `qualifiedSignals` |
| Total signals evaluated | per-cycle markets evaluated | `marketsEvaluated` |
| HR Radar state distribution | computeUnifiedCanonicalStage outputs | `hrRadarStates` |
| Avg engine probability | mean of `engineProbability` across signals | `avgProbability` |
| Avg projection edge | mean of `projection - bookLine` | `avgProjectionDelta` |
| Qualification reject rate | rejected / evaluated | `rejectRate` |
| API payload shape hash | hash of MLBSignal field set | `payloadShape` |

## GUARDRAIL THRESHOLDS

A `[MLB_DRIFT_WARNING]` fires when, compared to the rolling baseline of
the prior 24h:

- `qualifiedSignals` drops by >40% on 3+ consecutive cycles
- `rejectRate` rises by >15 percentage points
- `avgProbability` shifts by >5 percentage points
- `avgProjectionDelta` flips sign
- `payloadShape` hash changes (schema drift)
- HR Radar state distribution shifts by >25% in any single state

## RUNTIME CONTRACT

Implemented by `server/mlb/goldmasterGuard.ts`:

- `emitBootLock()` — fired once at server start
- `recordDriftSnapshot(snap)` — called at end of each per-game cycle
- `compareToBaseline()` — invoked inside recordDriftSnapshot, emits
  `[MLB_DRIFT_WARNING]` and `[MLB_SIGNAL_PARITY]` as appropriate
- `getDriftSnapshots(limit)` — exposed to admin debug for inspection

## WHAT THIS AGENT DOES NOT DO

- Does not block signals
- Does not modify engine math
- Does not auto-rollback
- Does not surface to non-admin users

It is a **passive observation layer**. All enforcement is human-driven via
`mlb-reset-skill.md`.
