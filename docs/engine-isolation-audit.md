# LiveLocks Engine Isolation Audit — Phase 3

Verifies that the NBA, MLB, and NCAAB sport engines do not share
sport-specific decision logic. Read-only investigation; no files moved.

A complementary doc, `docs/sport-isolation-audit.md`, exists from a
prior FIX 1 deliverable that classifies every shared helper. This doc
(Phase 3 of the 12-phase Goldmaster spec) is the verdict pass over the
current state of the codebase.

---

## Rule set

- **NBA logic stays NBA-only.**
- **MLB logic stays MLB-only.**
- **NCAAB logic stays NCAAB-only.**
- **Shared infrastructure is allowed** (database handle, schema, auth,
  date helpers, persistence, aggregation).
- **Shared probability / trigger / calibration math is NOT allowed.**

---

## Section A — Sport-owned files

### MLB

```
server/mlb/                           — primary engine package
  liveGameOrchestrator.ts             — heartbeat, reconcile loop, grade events
  hrAlertEngine.ts                    — HR signal scoring
  hrRadarSection.ts                   — canonical lifecycle/section helpers
  hrRadarUserStage.ts                 — user-facing stage derivation
  HRSignalBuilder.ts                  — HR signal construction
  probabilityEngine.ts                — MLB-specific phi/CDF + calibration
  dataPullService.ts                  — MLB Stats API pull
server/engines/mlb/index.ts           — engine entry point
shared/mlbSignal.ts                   — MLB-specific signal types
```

### NBA

```
server/nba/                           — primary engine package
  probabilityEngine.ts                — NBA-specific phi/CDF + calibration
  archetypes.ts                       — NBA archetype lookup
server/engines/nba/index.ts           — engine entry point
server/services/nbaStatsService.ts    — NBA stats API pull
server/services/nbaRotationHistoryService.ts — rotation history
```

### NCAAB

```
server/ncaabService.ts                — orchestration
server/ncaabEngine.ts                 — math (1500+ lines, fully self-contained)
```

### Shared infrastructure (allowed)

```
server/db.ts                          — Drizzle handle
server/storage.ts                     — CRUD over generic tables
server/auth.ts                        — sessions, requireAuth, requireAdmin, requireTier
server/utils/dateUtils.ts             — ET-day helpers
server/utils/access.ts                — tier→access map (sport-aware enablement only)
server/services/timingService.ts      — generic in-window check
server/services/playTracker.ts        — persistence ledger
server/services/gradePersistedPlays.ts — settle/grade infrastructure
server/services/engineStats.ts        — aggregation
server/services/engineSignal.ts       — generic shape validator
shared/schema.ts                      — Drizzle schemas (sport is a column value, not branching)
```

---

## Section B — Cross-sport import audit

Search performed:

- `server/mlb/**` importing from `server/nba*`, `server/ncaab*` — **none found**.
- `server/nba/**`, `server/services/nba*` importing from `server/mlb/**`,
  `server/ncaab*` — **none found**.
- `server/ncaab*` importing from `server/mlb/**`, `server/nba*` — **none found**.
- `client/src/components/mlb/**` importing from `nba/**` or `ncaab/**` — **none found**.
- `client/src/components/nba/**` (where present) importing from `mlb/**`
  or `ncaab/**` — **none found**.

**Verdict: clean.** No cross-sport imports detected at engine level.

The orchestration layers `server/routes.ts` and `server/storage.ts`
import from all sports — this is allowed because they route requests
and persist data, never make sport decisions.

---

## Section C — Probability / calibration / trigger audit

Each sport implements its own math locally. Naming overlap (`phi`,
`normalCDF`, `calibrate`) is **not** sharing — the implementations are
duplicated and specialized.

### Probability (Normal CDF)

| Sport | File | Line | Notes |
|---|---|---|---|
| MLB | `server/mlb/probabilityEngine.ts` | 8 | local `phi` |
| NBA | `server/nba/probabilityEngine.ts` | 31 | local `phi` |
| NCAAB | `server/ncaabEngine.ts` | 326 | local `normalCDF` |

This is the correct pattern: a tweak to one sport's math cannot bleed
into another sport.

### Calibration

| Sport | Function | File | Inputs |
|---|---|---|---|
| MLB | `calibrateModelProbability` | `server/mlb/probabilityEngine.ts:422` | `MLBMarket`, `isPitcherMarket` |
| NBA | `calibrate` | `server/nba/probabilityEngine.ts:324` | `isCombo`, `archetype`, `underBiasCorrectionActive` |
| NCAAB | `calibrateNCAABProbability` | `server/ncaabEngine.ts:1460` | `secsElapsed` (time-decay) |

Each calibration function has a sport-specific signature and sport-
specific tuning constants. None call into another sport's calibration.

### Trigger / qualification logic

Every sport has its own `noSignalReasons`, `confidenceTier`, and
qualification gate within its own directory. No shared "qualifier"
function decides for multiple sports.

---

## Section D — Verdict per sport

| Sport | Status | Notes |
|---|---|---|
| MLB | **ISOLATED** | All decision math in `server/mlb/`. Uses `MLBSignal` shared schema only. |
| NBA | **ISOLATED** | All decision math in `server/nba/` + dedicated services. |
| NCAAB | **ISOLATED** | Self-contained engine in `server/ncaabEngine.ts`. |
| Shared | **CLEAN** | Only infrastructure (schema, auth, persistence, dates). No sport math leaks across the boundary. |

---

## Sport-specific timing models (proof of independence)

Each sport's timing model is incompatible with the others, which is why
isolation matters:

- **NBA** runs a 4-quarter clock with a halftime window, an early Q3
  grace period, and 2H derived-line fallback. Halftime detection
  (`isNbaHalftimeWindow`) uses minutes/seconds parsing on ESPN
  scoreboard data.
- **MLB** runs an 18-half-inning game clock with at-bat granularity, a
  pitcher-batter matchup engine, and a per-PA HR Radar lifecycle. There
  is no halftime concept; instead, the orchestrator runs a 20s
  reconcile loop (`HR_RADAR_RECONCILE_MS = 20 * 1000`).
- **NCAAB** runs a 2-half basketball clock with halftime, a per-half
  qualified-edge gate, and pace-based derived totals when no book line
  exists.

If any of these timing models bled into another sport, the consequences
would be severe (e.g. MLB's HR-event resolver applied to a basketball
quarter clock would corrupt the grading ledger). The audit confirms
this has not happened.

---

## Conclusion

The codebase obeys the engine-isolation rule. No fixes required this
pass. Future engine-level changes (e.g. tweaking a calibration
constant) must continue to live in the sport-specific directory and
must not be promoted into a shared helper.
