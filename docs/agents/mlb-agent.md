# MLB ENGINE AGENT — LOCKED SPEC

## SYSTEM
Core Engine → MLB

## OBJECTIVE
Generate per-AB / per-pitch-cycle prop signals that surface high-probability,
explainable opportunities across batter and pitcher markets. Isolated from
NBA / NCAAB engine logic at all times.

## ENGINE TYPE
Discrete-event probability engine
- Driven by: at-bats, pitch count, lineup turn, live event modifiers
- Stabilized by: Phase 1.5 caps, Phase 3B wrappers, self-learning tiers
- Output cadence: continuous (every orchestrator cycle), filtered by qualification rules

## INPUTS (REQUIRED)

### Game Context
- Inning, top/bottom
- Score differential
- Park factor
- Weather (wind, temperature, humidity)

### Batter Context
- Current line stats (AB, H, HR, TB, RBI, R, SB, K, BB)
- Remaining PA expectation
- Batting order slot
- Archetype (elite_power, hot_streak, contact, limited_sample, …)
- Rolling form: last-N hard contact (EV/LA distribution, isBarrel)
- ABs since last HR (for HR timing component)

### Pitcher Context
- Pitch count, times through order
- Stuff / command / fatigue / contact-suppression
- Pitch mix by type (fastball%, breaking%, offspeed%)
- Velocity drop signal
- HR vulnerability score
- Last 3 starts: lastStartPitchCount, daysSinceLastStart, last3StartERA

### Live Performance
- Last AB contact: EV, LA, distance, xBA, isBarrel, outcome
- Prior AB results
- Statcast contact events feed

## CORE MODEL

### Probability Pipeline (LOCKED LAYERING)

```
Phase 1   computeModelProbability          → canonical sided probability
Phase 1.5 applyModelSafetyCeiling          → caps bind ABOVE all wrappers
Phase 2   deriveSignalTier(confidenceTier) → tier (watch/lean/strong/elite)
Phase 2.5 nearHrContact detection          → watch|lean tier from EV/LA/dist/xBA/barrel
          computePitchMixMatchupScore      → 12% weight in HR markets
          computeHrTimingComponent         → 8% weight in HR markets
          computePitcherEntryFatigueScore  → 5–8% weight in HR markets
          HR Watch context detection       → context only, never mutates probability
Phase 3B  HRR compression / hits_allowed shift / self-learn tiers
          + HR Watch additive signalScore bump (+3 watch, +6 lean)
```

Phase 3B math wrappers run BEFORE Phase 1.5 caps and are bounded by them.
Phase 3B HR Watch score bump NEVER mutates `engineProbability`,
`calibratedProbabilityOver`, `calibratedProbabilityUnder`, or `evPct`.

### HR Radar Lifecycle
State machine owned by `hrRadarStateMachine.ts`:
`inactive → watch → build → ready → fire → cashed|missed|model_review|expired`
Terminal states are sticky. `hrRadarCanonicalStore.ts` owns in-memory persistence.
No UI component derives lifecycle state.

### Non-HR Signal State
`nonHrSignalState.ts` mirrors the HR Radar pattern for batter-over and pitcher markets:
`BUILDING → ACTIVE → COOLING → CLOSED` (terminal). `COOLING` fires when
`signalScore` drops ≥ COOLING_DROP from peak. Daily slate-reset via
`clearStaleNonHrStates`.

### Display Contract (LOCKED)
The server stamps `displaySide`, `displayProbability`, `overProbability`,
`underProbability`, `displayGrade`, `isBettable`, `isWatchOnly`, and
`displayDrivers` in `applyDisplayContract`. Clients render these verbatim
and are PROHIBITED from re-deriving any of them.

## EDGE LOGIC
```
edge = displayProbability - 50
```
- Minimum edge handled per-market in `markets.ts`
- Side must align with projection vs line OR be explicitly justified

## SIGNAL RULES
- Surfaced when `qualifySignal` returns OK (per-market thresholds)
- HR markets travel through HR Radar lifecycle via `computeUnifiedCanonicalStage`
- HR Watch fires on non-HR batter markets via additive score bump only
- Near-HR contact detector (`nearHrContact.ts`) is a pure function — caller logs; no I/O

## OUTPUT FREQUENCY
- HIGH per cycle, qualified-down via `qualifySignal`
- Display-grade A+/A/B+/B/B-/Watch derived from `(signalTier × signalScore)`

## HARD INVARIANTS (NEVER VIOLATE)

1. **Phase 1 canonical probability is immutable** after engine returns it.
   No downstream layer rewrites `engineProbability` /
   `calibratedProbabilityOver` / `calibratedProbabilityUnder` /
   `recommendedSide`.
2. **Phase 1.5 caps bind above wrappers.** HRR ≤ 88, hits_allowed UNDER ≤ 74.
3. **Tier mapping is canonical.** `deriveSignalTier(confidenceTier)` is the
   only place 5-state confidence collapses into the 4-state tier.
4. **No UI compute.** Clients never derive probability, projection, tier,
   grade, lifecycle state, or signal conviction state.
5. **No route mutation.** Routes transport the signal — they never alter
   probability, side, drivers, edge, or projection.
6. **Sport isolation.** MLB code never imports NBA / NCAAB modules and vice-versa.
   Shared transport (`shared/`) is allowed; shared sport math is not.
7. **HR Radar lifecycle is engine-owned.** State transitions happen only in
   `hrRadarStateMachine.ts` + `hrAlertEngine.ts`. Clients render `hrAlert.*` verbatim.
8. **Near-HR contact detector is a pure function.** `nearHrContact.ts` has no I/O
   and must not be called with side effects.
9. **Signal gap components are additive to signalScore only.** Pitch mix, HR timing,
   and pitcher entry fatigue scores never touch `engineProbability` or `calibratedProbability*`.

## RESET PATH
See `mlb-reset-skill.md`. Baseline version constant lives in
`server/mlb/goldmasterGuard.ts` as `MLB_GOLDMASTER_VERSION`.

## DRIFT DETECTION
See `mlb-guardrail-agent.md`. Per-cycle drift snapshots feed
`recordDriftSnapshot()` and emit `[MLB_DRIFT_WARNING]` when deltas exceed
guardrail thresholds. Boot emits `[MLB_GOLDMASTER_LOCK]` once.

## OUTPUT CONTRACT
```json
{
  "plays": [],
  "engine": "MLB",
  "mode": "strict | fallback",
  "confidence": "developing | strong | elite",
  "signalTier": "watch | lean | strong | elite",
  "hrRadarState": "inactive | watch | build | ready | fire | ...",
  "nonHrSignalState": "BUILDING | ACTIVE | COOLING | CLOSED",
  "contactProfile": {},
  "diagnostics": {}
}
```
