# HR Radar Live Engine Fix Report

## Branch
`claude/keen-dirac-ph5uws`

## Commit
See the commit that adds this report (HEAD of the branch after this change).
Base inspected: `dddc1ec` (audit) → this fix builds on it.

## Scope Confirmation
- HR Radar only: **yes**
- Monte Carlo touched: **no** (none exists in HR Radar Live; added a test proving it)
- Pre-Game Power module touched: **no** (`server/mlb/pregamePowerRadar/**` unchanged)
- Power Prior added: **no**
- NBA/NCAAB touched: **no**
- Grading changed: **no** (FIRE-only record is preserved exactly)
- Scoring thresholds changed: **no**
- DB migrations: **no**

---

## Product Semantics Decision

**Ready vs Fire → Option B: FIRE-only is official. Ready is high-conviction watch
context, never an official/counted call.**

This was not a free choice — the codebase already encodes FIRE-only deeply and
intentionally, with a documented 2026-06 hit-rate rationale. Confirmed across:

- `server/mlb/hrRadarUserStage.ts:951–956` — `officialSignalStage = userStage === "fire" ? "fire" : null`, with the comment *"READY is high-watch context and is NOT an official call, so it must never be stamped here — otherwise READY false positives pollute the official HR record."*
- `server/mlb/hrRadarSection.ts:reachedFireCommitment` — official grade requires FIRE commitment (`fast_promote_elite` or `peakConversionProbability ≥ 0.14`).
- `server/mlb/hrRadarFreshnessOverlay.ts:104,181` — `officialSignalStage` / record-eligibility derive only from `section === "FIRE"`.
- `client/src/components/mlb/HrQuickDecide.tsx:258,378` — READY NOW already labeled *"High-conviction setup — not official call yet."*
- Tests already pinning it: `hrRadarReadyToFire.test.ts` (G.2), `hrRadarDisplayContract.test.ts`, `hrRadarRuntimeSmoke.test.ts`, `hrRadarDisplayState.test.ts`, `analytics/hrRadarOfficialSplit.test.ts`.

The only **mismatch** was leftover copy/comment in the full ladder
(`HrRadarLadder.tsx`) that still implied READY was actionable/graded. Per the
task rule *"do not change official grading unless Ready/Fire semantics are
confirmed wrong"* (they are not — FIRE-only is deliberate), the fix aligns the
UI to the already-enforced grading, and adds tests pinning the semantics.

**What now enforces it (code + UI + tests):**
- Grading/record: unchanged, FIRE-only (`officialSignalStage`, `reachedFireCommitment`, `displayRecordEligible`).
- UI copy: READY section description and the `isAttack` comment in `HrRadarLadder.tsx` now state READY is high-conviction watch context, **not** an official call (consistent with `HrQuickDecide`).
- Tests: new `server/mlb/hrRadarLiveOnly.test.ts` §3 asserts `enrichWithUserStage` stamps `officialSignalStage` for FIRE only; READY/BUILD/TRACK → `null`.

---

## Confirmed Problems Fixed

### P1 — HR Radar Live surfaced non-live "pregame seed" Track rows
**File/function:** `server/mlb/liveGameOrchestrator.ts -> LiveGameOrchestrator.periodicHRRadarRosterScan()` (no-AB seeding block, was ~L3217–3297).
**Current behavior (before):** For batters with **zero live plate appearances**, the scan computed a pregame prior score from park factor + wind + pitcher ERA + BvP HR history + hot-streak and, when `≥ 1.5`, seeded the canonical HR Radar state to **watch** (tag `PREGAME_SEED`) — surfacing a user-visible Track row built entirely from pregame context, with no in-game evidence.
**Why it was wrong:** HR Radar Live answers *"based on what is happening right now in this game, who is becoming live for a HR?"*. A Track row for a player who hasn't batted is a pregame prior / static HR-candidate surface, which the product definition explicitly forbids in HR Radar Live.
**Fix applied:** Added a dependency-free gate `isHrRadarPregameSeedEnabled()` (`server/mlb/hrRadarLiveContract.ts`), **default OFF**. The seeding block is skipped unless `HR_RADAR_PREGAME_SEED` is explicitly enabled, so the live ladder is live-evidence-driven by default. Reversible at runtime; no deletion of the logic.
**Behavioral risk:** **Low.** Seeded rows were always Track and were never graded (FIRE-only record), so the official W/L history is unchanged. The only effect is that no-AB batters no longer pre-surface as Track until they produce live contact. Goldmaster version bumped to document the intentional change (`v16 → v17`). Reversible via env.

> **PR #46 review addendum (approved scope expansion).** A Codex review found a
> *second* zero-AB pregame surface: the Task #126 **HR Presence Floor pass**
> (`liveGameOrchestrator.ts` ~4787–4872) writes `isPresenceOnly: true` WATCH/Track
> rows for season-stats power threats (slot/seasonHR/L30/barrel/hot-streak) using
> `computePregameSeed`, with `contactSnapshot: null` / `hasLiveABContext: false`.
> With explicit owner approval, this presence-only write is now gated behind the
> **same** `isHrRadarPregameSeedEnabled()` switch (default OFF), so no zero-AB
> pregame-context row surfaces by default. **Deliberate grading-coverage change:**
> presence-only rows are what make a *later* HR by these batters grade as
> `called_miss (presence-only)`; with the gate off, that presence-only coverage
> is reduced by design. The **FIRE-only official record** (`called_hit*` /
> official `called_miss`) is **unaffected** — presence-only misses are a separate,
> user-hidden grading bucket. **Not gated:** the "promote a live-contact row the
> PATH gate left behind" path (it requires real in-game contact) and the per-card
> pregame seed *floor* on engine-created PATH rows (the `HR_PREGAME_PRIOR` family,
> left intact per scope).

### P2 — UI implied READY was actionable/graded (contract mismatch)
**File/function:** `client/src/components/mlb/HrRadarLadder.tsx` — `SECTION_META.ready.description` (L294) and the `isAttack` comment (L686–688).
**Current behavior (before):** READY described as *"Playable HR setup"* and a comment asserted *"Fire + Ready are the actionable, graded tier."* Grading is FIRE-only, so this implied a counted call that grading ignores — exactly the mismatch the task prohibits.
**Why it was wrong:** Users could read READY as a bettable/official call, then find it absent from the official record. The `building` (ALMOST) section already carried the correct disclaimer; READY did not.
**Fix applied:** READY description now reads *"Strong HR setup forming — high-conviction watch context, not an official call until it fires."* The comment now states only FIRE is the official, graded call (`officialSignalStage="fire"` / `displayRecordEligible`); READY shares the visual "HR Max Window" treatment but never counts toward the record. No behavioral/styling change — copy + comment only.
**Behavioral risk:** **None** (display text + code comment).

### P3 — No regression proof that HR Radar Live is live-only / Monte-Carlo-free
**File/function:** new `server/mlb/hrRadarLiveOnly.test.ts`.
**Current behavior (before):** No test asserted the absence of Monte Carlo/simulation in the live engine, nor that the pregame seed is gated off, nor consolidated the FIRE-only semantics.
**Fix applied:** New suite (21 invariants):
1. Source scan of the 7 live HR Radar stage/scoring files asserts **no** Monte Carlo / `simulat*` / `Math.random` / `randomSample` tokens.
2. `isHrRadarPregameSeedEnabled` defaults OFF, fail-safe on garbage input, reversible when explicitly enabled.
3. `enrichWithUserStage` stamps `officialSignalStage` for FIRE only; READY/BUILD/TRACK → `null`.
4. The remaining engine-internal pregame HR-form prior (`computePregameHrFormBreakdown`) is **neutral (50) / `hasProfile=false` / no fabricated drivers** when profile data is absent — it never invents a pregame nudge from missing data.
**Behavioral risk:** **None** (test-only).

---

## Verifications (no change required)

### Track / Build never grade as official misses — confirmed
`hrRadarFireOnlyGrading.test.ts` #8–#11 already prove: `officialAlert` no-HR → `called_miss` only when fire-committed; READY-only no-HR → demoted to `expired`; `prepare/building` no-HR → `expired` (never a pick). Track/Build/Ready are not counted as official misses. Left unchanged.

### Engine-internal decaying pregame prior (`HR_PREGAME_PRIOR`) — left intact, flagged for product review
`server/mlb/hrConversionModel.ts:784–991` multiplies the live HR conversion `baseRate` by a season-power-profile prior that **decays to zero as live contact accumulates** (`pregamePriorMult = 1 + (fullMult-1)·(1-liveness)`), so it does not contaminate live-evidence-driven graded signals (the design's "no drift on live signals"). It is engine-internal (never a payload field), flag-gated (`HR_PREGAME_PRIOR`, default on), and is **not** Monte Carlo / slate ranking / simulation. Removing it would change Goldmaster engine math and first-AB coverage, so — given my clarifying question could not be delivered — I took the conservative path: **left it as-is**, added a test proving it's a no-op without profile data, and surfaced it here for an explicit product decision (see Remaining Risks). Once the no-AB seed is gated off (P1), the pre-contact prior has no surfacing path on its own.

### `hrr` vs `home_runs` — verified, already defended; not rewritten
- `shared/normalizeMlbMarket.ts` is the existing single normalizer: `home_runs` ← {hr, homer, homers, homerun, home_run}; **`hrr` ← {h+r+rbi, hits+runs+rbi…}** — i.e. `hrr` is the *hits+runs+rbi* market, distinct from `home_runs`.
- HR Radar cashing already **dual-attempts both** IDs (`server/mlb/hrPreHrBusEvidence.ts:41–42`: `…:hrr:OVER` and `…:home_runs:OVER`), so a cash cannot be silently dropped on the key it isn't registered under.
- A normalizer/helper already exists; cashing is defended. Per the task ("add a helper only if none exists; don't rewrite the market system") **no change** was made. The `hrr`=hits+runs+rbi naming overlap is documented here as a future-cleanup naming risk, not a confirmed disappearing-hit bug.

### Same-tick HR settlement — verified safe; not changed
The synthetic pre-close qualify event (`liveGameOrchestrator` `[HR_RADAR_PRE_CLOSE_QUALIFY]`) only fires when the engine had **already qualified** the batter (`wasQualified`) and is anchored strictly *before* the HR end-time, so it cannot fabricate a called-hit from nothing and preserves chronological truth. Not a confirmed bug → left unchanged (documented as fragile in the audit; revisit only with a dedicated change).

### `pitcherOrderSplits` — verified unwired pregame input; left as documented future work
Read by `pregamePowerRadar/*` only; no live producer. It is **not** an HR Radar Live input and its omission creates no live-signal defect, so — per the task — it was **not** wired.

---

## Files Changed
| File | Change |
| --- | --- |
| `client/src/components/mlb/HrRadarLadder.tsx` | READY copy + `isAttack` comment aligned to FIRE-only (display/comment only) |
| `server/mlb/liveGameOrchestrator.ts` | Gate no-AB `PREGAME_SEED` **and** Task #126 presence-only WATCH-row pass behind `isHrRadarPregameSeedEnabled()` (default OFF) |
| `server/mlb/hrRadarLiveContract.ts` | **New** — dependency-free live-only runtime gate (`isHrRadarPregameSeedEnabled`) |
| `server/mlb/goldmasterGuard.ts` | `MLB_GOLDMASTER_VERSION` v16 → v17 (documents intentional behavior change) |
| `server/mlb/hrRadarLiveOnly.test.ts` | **New** — 21-invariant suite: no Monte Carlo, seed gated off, FIRE-only, prior no-op |

---

## Tests Run

| Command | Result |
| --- | --- |
| `npx tsx server/mlb/hrRadarLiveOnly.test.ts` (new) | **21 pass, 0 fail** |
| `npx tsx server/mlb/hrRadarReadyToFire.test.ts` | **32 pass, 0 fail** |
| `npx tsx server/mlb/shadowOutcomeWiring.test.ts` | **26 pass, 0 fail** |
| `npx tsx server/mlb/phase3bRegression.test.ts` | **21 pass, 0 fail** |
| `npx tsx server/mlb/hrRadarFireOnlyGrading.test.ts` | **15 pass, 0 fail** |
| `npx tsx server/mlb/hrRadarStateMachine.test.ts` | **60 pass, 0 fail** |
| `npx tsx server/mlb/hrRadarDisplayContract.test.ts` | **31 pass, 0 fail** |
| `npx tsx server/mlb/hrRadarFreshnessOverlay.test.ts` | **37 pass, 0 fail** |
| `npx tsx server/mlb/hrRadarRuntimeSmoke.test.ts` | **10 pass, 0 fail** |
| `npx tsx server/analytics/hrRadarOfficialSplit.test.ts` | **10 pass, 0 fail** |
| `npx tsx client/src/components/mlb/hrRadarDisplayState.test.ts` | **54 pass, 0 fail** |

## Typecheck
`npx tsc --noEmit` → only the **3 pre-existing environment errors** (`Cannot find type
definition file for 'node'` / `'vite/client'` because `node_modules/@types/` is
empty in this container, plus the deprecated `baseUrl` warning). **Zero** new code
errors from the changed/added files (filtered grep over
`hrRadarLiveContract|hrRadarLiveOnly|hrRadarUserStage|liveGameOrchestrator|HrRadarLadder|goldmasterGuard`
returned nothing). Environment-only; the real app shell with `@types/node`
installed typechecks clean.

---

## Explicit Non-Changes
- No Monte Carlo added (and proven absent by test).
- No pregame simulation / Power Prior added or wired.
- No second HR Radar engine; no duplicate stage system.
- No grading logic, scoring threshold, or calibration change.
- No client-side engine computation introduced (UI still renders server-stamped fields).
- No NBA / NCAAB / Stripe / paywall / odds-behavior changes.
- No DB migration; no historical data mutated.
- Pre-Game Power module (`server/mlb/pregamePowerRadar/**`) untouched.

---

## Remaining Risks / Open Items for Product Owner
1. **Decaying engine-internal pregame prior (`HR_PREGAME_PRIOR`)** still nudges the pre-contact / first-AB HR conversion estimate before decaying to zero with live contact. It is engine-internal and not Monte Carlo, but it *is* a pregame power-profile prior. **Decision needed:** keep it (improves first-AB-HR coverage; self-erases once contact lands) or disable it via the existing flag for a strictly live-only conversion rate. I left it on to preserve Goldmaster; flip `HR_PREGAME_PRIOR=off` to test the live-only variant.
2. **No-AB seed is OFF by default now** → first-AB HRs on not-yet-batted players won't pre-surface as Track (the `early_hr_no_window` case the seed targeted). Re-enable with `HR_RADAR_PREGAME_SEED=on` if you want that coverage back. The official FIRE-only record is unaffected either way.
3. **`hrr` market naming overlap** (`hrr` = hits+runs+rbi, distinct from `home_runs`): cashing is dual-key-defended today; a future cleanup could centralize HR signalId construction so the canonical/legacy duality lives in one helper.
4. **My clarifying question (Ready/Fire option + pregame-prior scope) failed to deliver** (transient tool error); I proceeded with the conservative, evidence-backed defaults above. If you intended Ready to be an official graded stage (Option A) or wanted the decaying prior removed, those are follow-up changes I can make on confirmation.
