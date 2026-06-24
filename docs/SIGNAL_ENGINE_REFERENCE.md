# LiveLocks — Signal Engine Reference

**Status:** Active reference for the cross-sport signal engine.
**Last Updated:** April 2026
**Scope:** End-to-end pipeline from raw data sources through engine, normalizer, API, and UI for NBA, NCAAB, MLB (including HR Radar Goldmaster v1).

This is the single canonical reference for how a signal flows from ingestion to the user. If you are working anywhere in this pipeline, read this first; then read the focused sport doc ([NBA](../NBA_Model_Logic.md), [MLB](../MLB_Engine_Logic.md), [NCAAB](../NCAAB_Engine_Logic.md)) for math details.

---

## Table of Contents

1. [Architecture in one diagram](#1-architecture-in-one-diagram)
2. [The four pipeline stages](#2-the-four-pipeline-stages)
3. [Core engine surfaces (per sport)](#3-core-engine-surfaces-per-sport)
4. [The MLB signal pipeline in detail](#4-the-mlb-signal-pipeline-in-detail)
5. [HR Radar Goldmaster v1 — surfacing layer](#5-hr-radar-goldmaster-v1--surfacing-layer)
6. [Persistence and grading](#6-persistence-and-grading)
7. [Feature flags and rollback](#7-feature-flags-and-rollback)
8. [Standing rules and guardrails](#8-standing-rules-and-guardrails)
9. [File map](#9-file-map)

---

## 1. Architecture in one diagram

```
                    ┌──────────────────────────────────────────────┐
                    │  DATA SOURCES (read-only)                    │
                    │  ESPN · MLB Stats API · The Odds API · SGO   │
                    │  Baseball Savant · NBA.com Stats             │
                    └────────────────────┬─────────────────────────┘
                                         │ poll (10–90s)
                                         ▼
                    ┌──────────────────────────────────────────────┐
                    │  ENGINE  (math; never touched by surfacing)  │
                    │  • probabilityEngine.ts (MLB)                │
                    │  • hrAlertEngine.ts + evaluateHRAlert.ts     │
                    │  • signalScore.ts                            │
                    │  • NBA archetype engine                      │
                    │  • NCAAB pace + CDF engine                   │
                    └────────────────────┬─────────────────────────┘
                                         │ MLBSignal / NBASignal / NCAABMarket
                                         ▼
                    ┌──────────────────────────────────────────────┐
                    │  NORMALIZER (single source of truth)         │
                    │  normalizeMLBSignal() · engineSignal.ts      │
                    │  hrRadarUserStage.enrichWithUserStage()      │
                    └────────────────────┬─────────────────────────┘
                                         │ flat, UI-safe payload
                                         ▼
                    ┌──────────────────────────────────────────────┐
                    │  API (Express routes, thin)                  │
                    │  /api/mlb/* · /api/nba/* · /api/ncaab/*      │
                    └────────────────────┬─────────────────────────┘
                                         │ JSON over HTTPS
                                         ▼
                    ┌──────────────────────────────────────────────┐
                    │  UI (React + TanStack Query, presentational) │
                    │  HrRadarLadder · MlbSignalCard · NCAAB cards │
                    └──────────────────────────────────────────────┘
```

**Iron rule:** the UI does not compute. All probabilities, edges, tiers, labels, and stages are decided server-side. The UI selects, formats, and animates.

---

## 2. The four pipeline stages

### 2.1 ENGINE
- **Pure math.** Reads contact data, lines, archetypes, weather, calibration tables.
- **Outputs:** sport-specific signal objects (e.g. `MLBSignal`, `HRAlertSnapshot`, `NCAABMarket`).
- **Never** reads books-of-record beyond approved books. Never fabricates lines. Skips markets when no real line exists.
- **Never** mutated by surfacing layers (Goldmaster v1 etc.).

### 2.2 NORMALIZER
- **Single source of truth.** Flattens engine output into a UI-safe shape with sided probability already chosen, smart tags generated, and primary reasons composed.
- For MLB: `normalizeMLBSignal()` in `server/mlb/normalizer.ts`.
- For HR Radar v1: `enrichWithUserStage()` in `server/mlb/hrRadarUserStage.ts` produces an additive enrichment block (userStage, stageLabel, qualifyingSignals, score10, timestamps, official-signal shadow).

### 2.3 API
- **Thin routes.** Validate input, call storage/orchestrator, spread normalizer output, and return.
- HR Radar v1 spreads must be **flag-gated** so `HR_RADAR_GOLDMASTER_V1=false` truly removes v1 keys from the wire.

### 2.4 UI
- **Presentational only.** Reads `userStage`, `stageLabel`, `currentSignalScore10`, `qualifyingSignals`, etc. directly. No probability math. No tier derivation. No score conversion.

---

## 3. Core engine surfaces (per sport)

| Sport | Engine | Key types | Primary doc |
|---|---|---|---|
| NBA | Archetype + Z-score (7 archetypes) | `NBASignal` | [NBA_Model_Logic.md](../NBA_Model_Logic.md) |
| NCAAB | Pace + Normal CDF, CLV + public-fade | `NCAABMarket`, `Top Plays` | [NCAAB_Engine_Logic.md](../NCAAB_Engine_Logic.md) |
| MLB (props) | Distribution-first (NegBin / Binomial / Normal CDF) + 8 batter / 6 pitcher archetypes | `MLBSignal`, `MLBPropInput` | [MLB_Engine_Logic.md](../MLB_Engine_Logic.md) |
| MLB HR Radar | HR Engine v2 + Dynamic Alert State Machine | `HRAlertSnapshot` | [MLB_Engine_Logic.md §14](../MLB_Engine_Logic.md#14-hr-radar-goldmaster-v1--user-facing-surfacing-layer) + this doc §5 |

---

## 4. The MLB signal pipeline in detail

```
liveGameOrchestrator.ts (poll every 10s)
  ├── fetchSavantGameFeed                     [Statcast xBA / detail]
  ├── buildContactProfile                     [per-batter contact state]
  ├── HRSignalBuilder.buildHRSignal            [per-batter HR build score]
  ├── hrAlertEngine.evaluate                   [WATCH→PREPARE→BET_NOW state]
  ├── evaluateHRAlert                          [PATH_A / PATH_B / PATH_C]
  ├── markets.evaluateMarket  (per market)     [batter_over | under | hr_radar]
  ├── signalScore.computeSignalScore           [tier: ELITE/STRONG/SOLID/...]
  ├── liveEventInterpretation.computeLEI       [confidenceBoost + tags]
  ├── normalizeMLBSignal                       [flatten to MLBSignal]
  └── trackPlay → recordPlay (persist)         [persisted_plays upsert]

then:
  storage.getHrRadarLadder
    ├── enrichWithUserStage  (per entry, additive)        [Goldmaster v1]
    └── promote ready entries to sections.ready bucket    [v1, FF-gated]

routes.ts /api/mlb/hr-radar (legacy)
  └── enrichWithUserStage spread per entry, FF-gated

routes.ts /api/mlb/hr-radar-board
  └── enrichWithUserStage spread per row, FF-gated

routes.ts /api/mlb/hr-radar-grading-history
  └── subBuckets {missedOfficialSignals, lateSignals,
                  uncalledHrs, earlyWindowHrs, expiredTracking}
```

### 4.1 Signal modes (current MLB families)

| Family | Modes | Primary score |
|---|---|---|
| `batter_over` | watch · heating_up · lean · strong · elite | `signalScore` (SSS composite) |
| `under` / pitcher | edge model | `signalScore` (edge-based) |
| `hr_radar` | hr_watch · hr_heating_up · hr_strong · hr_elite | `hrBuildScore` (0–10) + alert state |

**Goldmaster v1 ladder** (Track / Build / Ready / Fire) is layered ON TOP of `hr_radar` family — it does not replace `hrBuildScore`, alert state, or any persistence.

---

## 5. HR Radar Goldmaster v1 — surfacing layer

### 5.1 Goal

Give end users a single legible ladder — **Track → Build → Ready → Fire** — with a 0–10 score, an "official signal" timestamp, and qualifying-signal chips. **Without modifying the HR engine, scoring, or calibration.**

### 5.2 The pieces

| Concern | Where | Notes |
|---|---|---|
| Feature flag | `hrRadarUserStage.ts:30` (`HR_RADAR_GOLDMASTER_V1`) | Default ON; env=false/0/off/no disables |
| Stage type | `HrRadarUserStage` | `track | build | ready | fire | resolved` |
| Legacy → user mapping | `mapToUserStage()` | reads legacyTier/legacyState/dynamicState/canonicalStage/outcome |
| 0–10 score | `toSignalScore10()` | accepts 0–10 or 0–100 input |
| Display fallback | `fallbackScoreForStage()` | track 2.5 / build 5.5 / ready 7.5 / fire 9.0 — display only |
| Stage label | `getUserStageLabel()` | "Track" / "Build" / "Ready" / "Fire" / "Resolved" |
| Stage copy | `getUserStageCopy()` | one-sentence user-safe explanation |
| Qualifying signals | `HrQualifyingSignalType` (9 values) + `deriveQualifyingSignals()` | derived from existing engine factors |
| Suggested stage | `deriveSuggestedUserStageFromSignals()` | from qualifying signals only |
| Combine | `strongerStage(legacyMapped, suggested)` | resolved is sticky |
| Enrichment | `enrichWithUserStage()` | one-shot additive payload |
| Validation log | `buildValidationPayload()` + `[HR_RADAR_V1_TRACE]` | only when FF on AND `DEBUG_HR_RADAR_V1=true` |

### 5.3 Wire shape (additive only)

Every ladder entry, board row, and legacy `/api/mlb/hr-radar` row gains (when the flag is on):

```ts
{
  userStage: "track" | "build" | "ready" | "fire" | "resolved";
  stageLabel: string;            // "Track" / "Build" / ...
  stageDescription: string;      // user-safe copy
  qualifyingSignals: HrQualifyingSignalType[];
  cleanReasons: string[];

  initialSignalScore10: number | null;  // 0.0–10.0
  currentSignalScore10: number | null;
  peakSignalScore10: number | null;

  officialSignalStage: "fire" | null;  // FIRE-only official record (2026-06)
  officialSignalAt: string | null;     // ISO
  officialSignalInning: number | null;

  firstTrackedAt:  string | null;  firstTrackedInning: number | null;
  firstBuiltAt:    string | null;  firstBuiltInning:   number | null;
  firstReadyAt:    string | null;  firstReadyInning:   number | null;
  firstFireAt:     string | null;  firstFireInning:    number | null;
  hrOccurredAt:    string | null;  hrOccurredInning:   number | null;

  adminReasons: string[];
  debugReasons: string[];
  enginePath: string | null;       // alertPath, e.g. "PATH_A_relaxed"
}
```

**No legacy field is removed or renamed.** When the flag is off, none of the above keys appear on the wire.

### 5.4 Ladder bucket promotion

`getHrRadarLadder()` produces five sections by default: `attackNow`, `building`, `watch`, `cooling`, `closed`. Goldmaster v1 adds a sixth: `ready`. A live entry whose `userStage === "ready"` is promoted into `sections.ready` instead of `building`/`watch`. **All non-ready entries continue to flow into the existing five sections exactly as before.**

`sectionPriority` ordering:

```
attackNow=1 → ready=3 → building=2 → watch=4 → cooling=5 → closed=6
```

### 5.5 Grading shadow

`officialSignalStage` is recorded **only when the row reaches `fire`** (FIRE-only official record, 2026-06). READY is high-watch context and is **not** an official call — it never stamps an official stage, so READY false positives cannot resolve as cashed/missed in the official HR record. The Phase 12 trace log (`[HR_RADAR_V1_TRACE]`) captures the candidate "v1 called hit" outcome (`wouldCountAsCalledHitV1` true iff the official signal precedes the HR). This is **shadow only** — current grading still uses `called_hit` until the shadow is validated.

The history endpoint adds a `subBuckets` object per day:

```ts
{
  missedOfficialSignals: number;  // FIRE signal that did not produce a HR (called_miss)
  lateSignals:           number;  // signal detected AFTER the HR
  uncalledHrs:           number;  // HR hit with no official signal at all
  earlyWindowHrs:        number;  // HR before the suggested window opened
  expiredTracking:       number;  // Track/Build aged out without escalating
}
```

These are **purely additive** — original `dead`/`missed`/`hit` counts are unchanged.

---

## 6. Persistence and grading

### 6.1 Tables

| Table | Owner | Notes |
|---|---|---|
| `persisted_plays` | `playTracker.trackPlay` → `recordPlay` | All sport signals (NBA, NCAAB, MLB props). Upsert keyed on canonical `playerId|market|direction|gameId|date`; keeps highest `signalScore`. |
| `hr_radar_alerts` | `createOrUpdateHrRadarAlert` | One row per (sessionDate, gameId, playerId). `detectedInning/detectedHalf/detectedAt` are **write-once** at CREATE. |
| `hr_radar_analytics` | `archiveDailyHrRadarOutcomesToAnalytics` | Durable per-day performance history. |
| `contact_events` | `HRSignalBuilder` | Per-batted-ball events for learning. |

### 6.2 Goldmaster v1 persistence (current)

The v1 timestamps and `officialSignalStage` are **derived in-memory** today. The follow-up ticket to persist them as write-once columns on `hr_radar_alerts` lives in the agent inbox — when implemented, `enrichWithUserStage` will read them off the row instead of deriving them.

---

## 7. Feature flags and rollback

| Flag | Default | Behavior when ON | Behavior when OFF |
|---|---|---|---|
| `HR_RADAR_GOLDMASTER_V1` | `true` | All v1 fields surfaced; Ready section promoted; v1 trace gated by `DEBUG_HR_RADAR_V1`. | Zero v1-only fields on the wire; ladder uses original 5 sections; no validation log. Engine math identical. |
| `DEBUG_HR_RADAR_V1` | `false` | When main flag is also on: emits one `[HR_RADAR_V1_TRACE]` JSON log per ladder row. | Silent. |

**Rollback procedure**: set `HR_RADAR_GOLDMASTER_V1=false` in the deployment env and restart. No DB migration needed; no data loss.

---

## 8. Standing rules and guardrails

These are the unbreakable rules for anyone touching the signal engine. The agent skill at `.local/skills/signal-engine/SKILL.md` enforces them.

1. **Never** modify HR engines (`hrAlertEngine.ts`, `evaluateHRAlert.ts`, `HRSignalBuilder.ts`), MLB probability engine (`probabilityEngine.ts`), NBA archetype engine, NCAAB engine, scoring (`signalScore.ts`), or calibration. New work is **surfacing/qualification only.**
2. **Never** remove or rename existing fields on a wire payload, ladder entry, board row, or persisted row. Add new fields; keep the old ones populated.
3. **Never** mutate the write-once fields on `hr_radar_alerts` (`detectedInning`/`detectedHalf`/`detectedAt`) on UPDATE.
4. **Never** fabricate book lines. If no approved-book line exists, skip the market.
5. **Never** move engine logic into the frontend. The UI selects and formats; the server decides.
6. **Always** flag-gate new wire surfacing layers so they can be rolled back via env.
7. **Always** flag-gate noisy debug logs (`DEBUG_*`) on top of the feature flag.
8. **Always** keep the engine identical when a feature flag is OFF — verify by removing the flag spread block and confirming the response is byte-identical to pre-flag main.

---

## 9. File map

```
server/mlb/
  hrAlertEngine.ts              ← engine (do not modify)
  evaluateHRAlert.ts            ← engine (do not modify)
  HRSignalBuilder.ts            ← engine (do not modify)
  signalScore.ts                ← scoring (do not modify)
  probabilityEngine.ts          ← engine (do not modify)
  liveGameOrchestrator.ts       ← orchestration; do not change math
  liveEventInterpretation.ts    ← LEI computation
  hrRadarUserStage.ts           ← Goldmaster v1 helpers (THIS LAYER)
  normalizer.ts                 ← MLBSignal flattener
  markets.ts                    ← per-market evaluators
  marketFamily.ts               ← family classifier

server/storage.ts
  getHrRadarLadder              ← enriches each entry; promotes Ready
  getHrRadarGradingHistory      ← additive subBuckets
  createOrUpdateHrRadarAlert    ← write-once detection fields
  HrRadarLadderEntry type       ← extended with v1 fields

server/routes.ts
  /api/mlb/hr-radar             ← v1 enrichment IIFE, FF-gated
  /api/mlb/hr-radar-board       ← v1 enrichment, FF-gated
  /api/mlb/hr-radar/ladder
  /api/mlb/hr-radar-analyze/:playerId/:gameId
  /api/mlb/hr-radar-grading-history
  /api/mlb/hr-radar-grading/:sessionDate

client/src/components/mlb/
  HrRadarLadder.tsx             ← 6 sections incl. Ready; v1 type fields
  MlbSignalCard.tsx             ← shared card (read v1 fields directly)

client/src/lib/
  mlbUiMappers.ts               ← display helpers (formatDetectedLabel etc.)

shared/
  schema.ts                     ← DB schema; hrRadarAlerts ~L587-651
  mlbSignal.ts                  ← MLBSignal type
  routes.ts                     ← shared route constants

docs/
  SIGNAL_ENGINE_REFERENCE.md    ← this file

.local/skills/signal-engine/
  SKILL.md                      ← agent guardrails (mandatory read)
  references/
    hr_radar_pipeline.md
    goldmaster_v1.md
    safe_upgrade_playbook.md
```
