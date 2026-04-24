# Sport-Isolation Follow-Ups (Deferred Structural Work)

This document is the staged implementation plan for the structural fixes
from the cross-sport contamination prompt that were intentionally deferred
in the safe-additive pass.

Each section below is sized to be one project task. Dependencies are noted.
Estimated effort assumes one engineer, no engine-math changes inside the
listed file moves.

---

## FOLLOWUP 1 — Route split (FIX 2)

**Goal:** Split `server/routes.ts` (8001 lines) into per-sport route files
so a change in one sport's surfacing path cannot touch another.

**Target files (new):**
- `server/routes/nbaLive.ts` — `/api/live-signals` and friends
- `server/routes/nbaHalftime.ts` — `/api/halftime-signals` and friends
- `server/routes/mlbLive.ts` — `/api/mlb-live-signals`, `/api/mlb/boxscore-engine-state/:gameId`
- `server/routes/ncaabLive.ts` — `/api/ncaab-signals`
- `server/routes.ts` keeps: auth, admin, lifecycle, alerts, top-plays, public-analytics, debug routes

**Extraction order (do in this order to keep diffs reviewable):**
1. Extract NCAAB first — smallest surface, single endpoint, isolated math.
2. Extract NBA halftime — high-blast-radius but well-bounded by the
   `if (edge < 4) continue` gate at routes.ts:5201.
3. Extract NBA live — depends on shared signal-evaluation helpers; pull
   those into `server/nba/` as a side-step, not into the new route file.
4. Extract MLB live LAST — touches HR-engine-adjacent code; do this with
   FOLLOWUP 5 (MLB calibration namespace) decided up front so we don't
   refactor the same MLB code twice.

**Acceptance:**
- Each new route file is < 1000 lines.
- `routes.ts` registers the per-sport route modules at startup; per-sport
  files do not import from each other.
- `node scripts/drift-check.mjs` passes (no engine-math drift).
- Manual smoke: NBA live, NBA halftime, NCAAB, MLB live endpoints all
  return their previous payload shape.

**Estimated effort:** 1.5–2 days, single PR per extraction (4 PRs total).

**Blocked by:** nothing. Can start immediately.

---

## FOLLOWUP 2 — Sport odds adapters (FIX 3)

**Goal:** Wrap shared `getPlayerOdds()` so each sport explicitly chooses
its stale-line / degraded-fallback policy at the boundary, not by accident.

**Target files (new):**
- `server/odds/nbaLiveOddsAdapter.ts` — `getNBALiveOdds(eventId, player, market)`
- `server/odds/nbaHalftimeOddsAdapter.ts` — `getNBAHalftimeOdds(...)` — strict live only, no stale, no derived, no pregame fallback
- `server/odds/mlbOddsAdapter.ts` — `getMLBLiveOdds(...)` — degraded fallback acceptable (preserves today's MLB behavior)
- `server/odds/ncaabOddsAdapter.ts` — `getNCAABLiveOdds(...)` — fallback-safe (preserves today's NCAAB behavior)
- `server/oddsService.ts` keeps the raw `getPlayerOdds()` but no decisioning code may call it directly after this lands.

**Adapter contract (each sport adapter):**
```
{
  ok: true,
  source: "live_inplay" | "live_pregame" | "stale" | "derived" | "consensus",
  staleSeconds: number,
  over?: number,
  under?: number,
  line: number,
  derivedLine: boolean,
  bestBookSnapshot?: object,
} | { ok: false, reason: string }
```

**Migration order:**
1. Land the four adapter files with the sport policies hard-coded inside.
2. Add an ESLint rule (FOLLOWUP 4) banning direct `getPlayerOdds` import
   outside `server/odds/*` and `oddsService.ts`.
3. Migrate the 5 known callers in `routes.ts` (NBA halftime, NBA live, MLB
   live x2, top-plays) one at a time, behind the drift-check harness.

**Acceptance:**
- `rg "getPlayerOdds\(" server | grep -v "server/odds/" | grep -v oddsService.ts` returns zero hits.
- Each per-sport endpoint's response shape unchanged.
- Drift-check harness still passes for NBA + MLB.
- A new fixture per adapter validating the adapter's stale-line policy.

**Estimated effort:** 2 days.

**Blocked by:** FOLLOWUP 1 (route split) — easier to migrate callers when each route lives in its own file.

---

## FOLLOWUP 3 — Threshold ownership extraction (FIX 5)

**Goal:** Every numeric edge / probability gate currently inline in
`routes.ts` (catalogued in `docs/sport-isolation-audit.md` §3) moves into
a sport-owned constants file. No shared global edge suppression survives.

**Target files (new):**
- `server/engines/nba/thresholds.ts` — `NBA_LIVE_MIN_EDGE = 3`, `NBA_HALFTIME_MIN_EDGE = 4`, `NBA_LIVE_TIER_LADDER`, `NBA_HALFTIME_TIER_LADDER`, `NBA_HALFTIME_TIER_SELECTION`
- `server/engines/ncaab/thresholds.ts` — `NCAAB_TIER_LADDER` (the inline 75/65/55 ladder at routes.ts:517)
- `server/engines/mlb/thresholds.ts` — exists implicitly as `MLB_STRICT_RULES`/`MLB_FALLBACK_RULES`; add a re-export only, do not move math (HR-engine protected)

**Migration order:**
1. Create the new threshold files with the values copied verbatim from `routes.ts`.
2. Update `routes.ts` to import the constants instead of inlining numbers.
3. Run drift-check harness — output must be bit-identical.

**Acceptance:**
- `rg "edge\s*[<>=!]+\s*[0-9]" server/routes.ts` returns zero hits in
  surfacing paths (display-only call sites like `/api/live-signal-counts`
  may keep numeric literals if they're labeled as "display only").
- Each threshold file documents the sport that owns it.
- Drift-check harness passes with zero changes.

**Estimated effort:** 1 day after FOLLOWUP 1.

**Blocked by:** FOLLOWUP 1.

---

## FOLLOWUP 4 — Ownership enforcement (FIX 9)

**Goal:** Make cross-sport contamination an immediate lint error, not
something a code review has to catch.

**Mechanism:**
- Add an `eslint.config.js` (or extend the existing tsconfig path-alias
  rules) with `no-restricted-imports`:
  - Files matching `server/engines/nba/**` MAY NOT import from
    `server/engines/mlb/**` or `server/engines/ncaab/**` (and vice versa).
  - Files outside `server/odds/**` and `server/oddsService.ts` MAY NOT
    import `getPlayerOdds` directly.
  - Files outside `server/engines/*/thresholds.ts` MAY NOT export numeric
    edge constants (regex-checked in CI).
- Add an `npm run lint:contamination` script that runs the above rule
  set in isolation so CI failures are easy to diagnose.

**Note:** Adding npm scripts requires editing `package.json`, which the
user has restricted. This task should ask for explicit permission before
modifying `package.json`. Workaround: ship the eslint config + a
standalone runner script (`scripts/check-contamination.mjs`) that doesn't
need a package.json entry.

**Acceptance:**
- `node scripts/check-contamination.mjs` exits non-zero on any
  cross-sport import or shared-threshold violation.
- README section documents how to add a new sport (NFL) without
  triggering the rules.

**Estimated effort:** 0.5 day.

**Blocked by:** FOLLOWUP 2 + FOLLOWUP 3.

---

## FOLLOWUP 5 — MLB / HR calibration namespace (FIX 4)

**Status: REQUIRES USER APPROVAL TO START.**

**Goal:** Move MLB confidence ceilings, calibration shrink, and volatility
suppression into a dedicated `engines/mlb/confidence/*` namespace, in
parallel with the existing NBA confidence work.

**Conflict with standing rules:** The user has set the hard rule
*"never modify HR engines/scoring/calibration."* MLB confidence math
currently lives inside `engines/mlb/index.ts` (`mapMLBConfidence`),
`engines/mlb/types.ts` (`MLB_STRICT_RULES`), and `engines/mlb/validation.ts`.
Any move touches that code.

**Two paths to unblock:**

**Option A — extraction-only refactor (low risk):**
- Move the relevant exports into new files under `engines/mlb/confidence/`.
- Re-export them from the old paths so no caller breaks.
- Prove bit-identical output via the drift-check harness with a frozen
  fixture set the user signs off on.
- Requires user to relax the rule for the duration of the move.

**Option B — leave MLB confidence in place (zero risk):**
- Document the exception in the audit doc (already done — see
  `sport-isolation-audit.md` §4).
- Apply FIX 4 only to NBA (NCAAB has no engine to extract from yet).
- Accept that "shared confidence helper" never materially existed for
  MLB anyway because MLB confidence is already in `engines/mlb/`.

Recommendation: **Option B**. The original FIX 4 concern was a SHARED
`confidence.ts` controlling multiple sports. Empirically, no such file
exists today — MLB confidence is already sport-owned, just not in a
sub-namespace called `confidence/`. The architectural goal is met; the
folder rename is cosmetic.

**Estimated effort:**
- Option A: 1 day refactor + 1 day fixture validation.
- Option B: 0 days (document the exception; close the followup).

**Blocked by:** explicit user decision between A and B.

---

## Dependency graph

```
FOLLOWUP 1 (route split)
    ├── FOLLOWUP 2 (odds adapters)
    │       └── FOLLOWUP 4 (ownership enforcement)
    └── FOLLOWUP 3 (threshold ownership)
            └── FOLLOWUP 4 (ownership enforcement)

FOLLOWUP 5 (MLB confidence) — independent, blocked on user decision
```

Total deferred effort: ~5–6 working days for FOLLOWUPS 1–4 in sequence,
plus 0–2 days for FOLLOWUP 5 depending on the user's choice.
