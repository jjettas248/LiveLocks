# MLB ENGINE AGENT — LOCKED SPEC

## SYSTEM
Core Engine → MLB

## OBJECTIVE
Generate per-pitch / per-PA prop signals that surface high-probability,
explainable opportunities across batter and pitcher markets while staying
isolated from NBA / NCAAB engine logic.

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
- Weather (when available)

### Batter Context
- Current line stats (AB, H, HR, TB, RBI, R, SB, K, BB)
- Remaining PA expectation
- Batting order slot
- Archetype (elite_power, hot_streak, contact, limited_sample, …)
- Rolling form (last-N hard contact, EV/LA distribution)

### Pitcher Context
- Pitch count
- Times through order
- Stuff / command / fatigue / contact-suppression
- Pitch mix + velocity drop signal
- HR vulnerability score

### Live Performance
- Last AB contact (EV / LA / outcome)
- Prior AB results
- Statcast contact events feed

## CORE MODEL

### Probability Pipeline (LOCKED LAYERING)

```
Phase 1   computeModelProbability         → canonical sided probability
Phase 1.5 applyModelSafetyCeiling         → caps bind ABOVE wrappers
Phase 2   deriveSignalTier(confidenceTier)→ tier (watch/lean/strong/elite)
Phase 2.5 HR Watch context detection      → adds context, never mutates probability
Phase 3B  HRR compression / hits_allowed shift / self-learn tiers
          + HR Watch additive signalScore bump (+3 watch, +6 lean)
```

Phase 3B math wrappers run BEFORE Phase 1.5 caps and are bounded by them.
Phase 3B HR Watch score bump NEVER mutates `engineProbability`,
`calibratedProbabilityOver`, `calibratedProbabilityUnder`, or `evPct`.

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
- HR markets travel through HR Radar lifecycle (`computeUnifiedCanonicalStage`)
- HR Watch fires on non-HR batter markets via additive score bump only

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
   grade, or lifecycle state.
5. **No route mutation.** Routes transport the signal — they never alter
   probability, side, drivers, edge, or projection.
6. **Sport isolation.** MLB code never imports NBA / NCAAB / future NFL
   modules and vice-versa. Shared transport (`shared/`) is allowed; shared
   sport math is not.
7. **HR Radar lifecycle is engine-owned.** Clients render `hrAlert.*`
   verbatim. State transitions happen only in `hrAlertEngine.ts`.

## RESET PATH
See `mlb-reset-skill.md`. Baseline version constant lives in
`server/mlb/goldmasterGuard.ts` as `MLB_GOLDMASTER_VERSION`.

## DRIFT DETECTION
See `mlb-guardrail-agent.md`. Per-cycle drift snapshots feed
`recordDriftSnapshot()` and emit `[MLB_DRIFT_WARNING]` when deltas exceed
guardrail thresholds. Boot emits `[MLB_GOLDMASTER_LOCK]` once.
