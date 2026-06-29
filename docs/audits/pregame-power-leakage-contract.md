# Pre-Game Power Radar — v2 Leakage Contract

**Implemented by:** `server/mlb/pregamePowerRadar/math/leakageGuard.ts` (pure,
dependency-free). **Tested by:** `math/leakageGuard.test.ts` (37 assertions).

This contract guarantees the v2 math core consumes **pre-first-pitch information
only**. It is a hard rule of the task: no current-game / in-progress data may ever
influence a pregame HR candidate.

## The rule

1. A v2 prediction must be **locked before first pitch**
   (`isPredictionBeforeFirstPitch(predTs, firstPitchTs)`).
2. **No live-only feature** may feed the model. The forbidden set (substring,
   case-insensitive, alnum-normalized — so `currentGameBarrel`,
   `current_game_barrel`, `liveBarrel` all match):
   - current-game Statcast: EV, launch angle, barrel, hard-hit, spray, exit velocity, any "currentGameStatcast"
   - live count/situation: pitch count, balls/strikes, base-out, outs, inning, live score
   - live pitcher state: deterioration, command decay, velocity drop, live fatigue
   - live environment: live/current wind, intra-game wind shift
   - generic `live*` / `inGame*` markers
3. A feature whose `valueTimestamp` is **after first pitch** is flagged even if its
   name looks season-safe.
4. A feature explicitly tagged `phase: "live"` is rejected regardless of name.

## Public helpers (all pure)

| Helper | Behavior |
| --- | --- |
| `isLiveOnlyFeatureName(name)` | `true` for any forbidden substring. Never throws. |
| `isPredictionBeforeFirstPitch(predTs, fpTs)` | `true` iff `predTs ≤ fpTs`; `false` on missing/invalid timestamps. |
| `assertPregameFeatureAllowed(name)` | Throws `PregameLeakageError` **only** for a live-only name. The one intentional throw — for explicit ingest sites. |
| `filterLeakyFeatures(features)` | Partitions into `{ allowed, rejected }`. Never throws; `null`/partial input → empty partitions. |
| `buildLeakageWarnings({predTs, fpTs, features})` | Returns warning strings (missing/invalid timestamps, post-first-pitch lock, live-only feature, feature-timestamp-after-first-pitch). Never throws. |

## Why the runtime model emits no leakage warnings

`PregameMathInputs` (the v2 input contract) is **structurally pre-first-pitch**: it
has no fields for live count, inning, base-out, or current-game Statcast. There is
nothing for a per-candidate scan to flag, so `runPregameMathModel(...)` returns an
empty `leakageWarnings` array on clean input. The guard helpers exist for the
**ingest boundary** — any builder that maps raw, name-addressed feature dictionaries
into `PregameMathInputs` should run `filterLeakyFeatures` / `assertPregameFeatureAllowed`
first, and may attach `buildLeakageWarnings(...)` output to the result.

## Test coverage (leakageGuard.test.ts)
- rejects live EV / launch-angle / barrel / hard-hit / pitch-count / count / base-out / inning / live decay / live wind / spray / live Statcast
- accepts season / pre-first-pitch features (xISO, season barrel, HR/9 vs hand, slot, park factor, forecast wind, rolling rates, bat speed)
- `assert` throws on live-only, not on season features
- prediction-before-first-pitch window (before/after/missing-timestamp)
- `filterLeakyFeatures` partitions and never throws on `null`/`undefined`
- `buildLeakageWarnings`: clean row → none; missing timestamps → warnings; post-lock → warning; live feature → warning; feature-timestamp-after-first-pitch → warning
