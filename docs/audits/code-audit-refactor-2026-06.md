# Code Audit & Refactor — Dead & Conflicting Code

**Date:** 2026-06-30
**Branch:** `claude/code-audit-refactor-8ce6gf`
**Scope:** Repo-wide dead-code removal + conflicting/duplicate-logic audit.
**Method:** `knip@5` (scoped config) for unused files/exports/deps, cross-checked
by manual `grep` for dynamic imports, CLI entry points, and test references.
Verified with `tsc --noEmit` + the MLB regression suites (all green).

---

## 1. What was removed (this PR)

16 files with **zero** static, dynamic, CLI, route, or test references. Each was
confirmed dead by import-path grep before deletion; the full suite passed after.

### Server (engine / services)
| File | Lines | Why dead |
| --- | --- | --- |
| `server/mlb/hrRadarState.ts` | 16 | **Conflicting** — superseded HR-Radar state model (`watch\|building\|attack\|cashed\|missed`) that contradicts the canonical `hrRadarStateMachine.ts` graph (`inactive→watch→build→ready→fire→…`). No importers. |
| `server/mlb/gameMarkets.ts` | 268 | Unwired "Phase 5" game-level markets feature (full-game/F5/team totals). Never imported. |
| `server/mlb/calibration.ts` | 23 | Thin wrapper over `directionalBias` helpers; no importers. |
| `server/mlb/pregamePowerRadar/math/index.ts` | barrel | Unused barrel; the individual `score*` modules it re-exported are still used directly by their tests. |
| `server/services/alertHooks.ts` | 90 | Generic alert-candidate dispatch; never wired into the bus/alert path. |
| `server/services/consensusLineService.ts` | 110 | Generic consensus-line aggregator; superseded, no importers. |
| `server/services/liveFreshness.ts` | 24 | Freshness type/helper; no importers (freshness now handled in the canonical store overlay). |

### Client
| File | Why dead |
| --- | --- |
| `client/src/components/common/QueryState.tsx` | No importers. |
| `client/src/components/common/TierBadge.tsx` | No importers (an unrelated inline `TierBadge` lives in `admin.tsx`). |
| `client/src/components/dashboard/public-proof-strip.tsx` | No importers. |
| `client/src/components/dashboard/TrustTrackRecordPanel.tsx` | No importers. |
| `client/src/components/mlb-admin-tab.tsx` | No importers. |
| `client/src/components/mlb/MLBScheduleList.tsx` | No importers. |
| `client/src/components/RecentResults.tsx` | No importers. |
| `client/src/components/sports/SportPageShell.tsx` | No importers. |
| `client/src/lib/mlbValidation.ts` | No importers. |

### Docs synced
Removed the dangling `hrRadarState.ts` reference from `CLAUDE.md`, `README.md`,
and `docs/agents/mlb-lock-standard.md`. (Point-in-time `docs/audits/*` snapshots
left as historical record.)

---

## 2. Explicitly KEPT (flagged by tooling, but not dead)

- **`server/validation/nba/run.ts`** and **`server/validation/nba/playoffSmoke.ts`** —
  documented CLI runners (`npx tsx server/validation/nba/run.ts`, `isMain` guard).
  Flagged only because nothing *imports* them; they are entry points.
- **shadcn/ui kit (38 files) + `hooks/use-mobile.tsx`** — generated component library
  boilerplate. Conventionally retained as a complete kit; removing it is a cosmetic
  decision, not a correctness one. See §4.

---

## 3. Conflicting / duplicate logic

| Finding | Status |
| --- | --- |
| `hrRadarState.ts` parallel state model vs `hrRadarStateMachine.ts` | **Resolved** (removed). |
| 4× `classifyTier` (`ConfidenceBadge.tsx`, `mlbFormatters.ts`, `topPlaysService.ts`, `pregamePowerRadar/scoring.ts`) | **Not a true conflict** — independent same-named local helpers across different sports/layers. 2 client copies are unused (see §4). Left for triage to avoid touching display-contract logic. |
| 2× `clamp`, 2× `clamp01`, 2× `_resetForTests` | Benign local utilities / per-module test resets. Not consolidated (low value, would add cross-module coupling). |
| "Duplicate exports": `MlbSlateRibbon`, `PregamePowerRadar` | Harmless — each has both a named and a default export. No action. |

---

## 4. Deferred for owner decision (NOT changed)

These are real findings but removing them carries risk or is a judgment call, so
they are documented rather than applied in this PR.

### 4a. Unused exports (~319) and exported types (~348)
Spread across otherwise-live files. **Do not bulk-delete** — a large share are
protected by CLAUDE.md §7a as *intentionally-staged, additive model features*:
- `server/mlb/featureEngineering.ts` (18) — `computeSpec*`, `contactQualityScore`,
  `pitcherVulnerabilityScore`, etc. Staged engine inputs (no-op when absent).
- `server/mlb/diagnosticsBuffer.ts` (17) — diagnostic getters (observability surface).
- `server/ncaabEnrichment.ts` (22), `server/services/timingService.ts` (15),
  `server/mlb/markets.ts` (15), `server/mlb/dataPullService.ts` (14) — top remaining clusters.

Recommendation: triage per-file with the engine owner; safe wins are the dead
client display duplicates (`mlbUiMappers.ts`, `mlbFormatters.ts`, the unused
`classifyTier` copies) which never feed the display contract.

### 4b. Dependencies
`knip` flags 37 deps + 8 devDeps. **Mixed signal — verify before removing:**
- **False positives** (used in config files excluded from analysis):
  `@vitejs/plugin-react`, `@tailwindcss/vite`, `@replit/vite-plugin-*`.
- **Coupled to the unused UI kit** (removable only if §2 UI kit is pruned):
  all `@radix-ui/react-*`, `cmdk`, `vaul`, `input-otp`, `embla-carousel-react`,
  `react-day-picker`, `react-resizable-panels`, `next-themes`, `tw-animate-css`.
- **Genuinely unused (0 import sites, safe to remove)**: `date-fns`, `passport`,
  `passport-local`, `memorystore`, `ws`, `zod-validation-error`,
  `@jridgewell/trace-mapping`, and the matching `@types/passport`,
  `@types/passport-local`, `@types/ws`.

Per-`package.json` Hard Rule #7 (use package tooling, not hand edits), dependency
pruning was intentionally left out of this PR.

---

## 5. Verification
- `tsc --noEmit` — clean (0 errors).
- Regression suites — all green: `phase3bRegression` (21), `hrRadarStateMachine`
  (60), `hrRadarLifecycleRepair` (34), `shadowOutcomeWiring` (26),
  `hrReviewClassifier` (30), `pregamePowerRadar/winAttribution` (42).
