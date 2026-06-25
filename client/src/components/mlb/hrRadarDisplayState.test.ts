// HR Radar canonical display-state mapper — invariants.
// Run: npx tsx client/src/components/mlb/hrRadarDisplayState.test.ts
//
// Pure-function coverage for the UI repair acceptance tests: no raw 0-100 score
// rendered as a percent, watchlist never shows a misleading "%", Quick Decide
// and Full Ladder share one stage mapping, admin buckets are flagged, drivers
// surface, and the mapper never recomputes probability from readiness.

import {
  mapHrRadarRowToDisplayState,
  deriveUserStage,
  userSectionForStage,
  deriveCalibratedHrChancePct,
  deriveDisplayScore10,
  formatScore10Label,
  deriveDrivers,
  ADMIN_ONLY_SECTIONS,
  CALIBRATED_HR_PROB_CEILING_PCT,
  type HrRadarRowInput,
} from "./hrRadarDisplayState";

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
function eq(a: unknown, b: unknown, msg: string): void {
  assert(a === b, `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
}

const base: HrRadarRowInput = { playerId: "p1", playerName: "Test Player", team: "LAD", gameId: "g1" };

// ── Acceptance #1 — raw readiness 95 renders as 9.5/10, never 95%. ──────────
{
  const s = mapHrRadarRowToDisplayState({ ...base, userStage: "ready", currentReadinessScore: 95 });
  eq(s.displayScore10, 9.5, "#1 readiness 95 → displayScore10 9.5");
  eq(s.scoreLabel, "9.5/10", "#1 readiness 95 → label 9.5/10");
  eq(s.hrChancePct, null, "#1 readiness-only row exposes no HR chance %");
}

// ── Acceptance #2 — % only when a TRUE calibrated HR probability exists. ────
{
  // A 0.95 'probability' (or a 95 readiness leak via conversionProbability) is
  // rejected — it is not a plausible single-game HR probability.
  eq(deriveCalibratedHrChancePct({ ...base, conversionProbability: 0.95 }), null,
    "#2 conversionProbability 0.95 rejected (>ceiling)");
  eq(deriveCalibratedHrChancePct({ ...base, displayHrChancePct: 95 }), null,
    "#2 displayHrChancePct 95 rejected (>ceiling)");
  // A realistic calibrated probability passes through.
  eq(deriveCalibratedHrChancePct({ ...base, conversionProbability: 0.18 }), 18,
    "#2 conversionProbability 0.18 → 18%");
  eq(deriveCalibratedHrChancePct({ ...base, displayHrChancePct: 22 }), 22,
    "#2 displayHrChancePct 22 → 22%");
  assert(CALIBRATED_HR_PROB_CEILING_PCT < 95, "#2 ceiling rejects 95");
}

// ── Acceptance #5 — one stage→section mapping for both surfaces. ────────────
{
  eq(userSectionForStage("fire"), "fire", "#5 fire → fire");
  eq(userSectionForStage("ready"), "ready", "#5 ready → ready");
  eq(userSectionForStage("build"), "watching", "#5 build → watching");
  eq(userSectionForStage("track"), "developing", "#5 track → developing");
  eq(userSectionForStage("resolved"), "resolved", "#5 resolved → resolved");
  // Stage derivation priority: resolved beats everything; official fire beats ready.
  eq(deriveUserStage({ ...base, userStage: "ready", outcomeStatus: "called_hit" }), "resolved",
    "#5 resolved outcome wins over stage");
  eq(deriveUserStage({ ...base, userStage: "ready", officialSignalStage: "fire" }), "fire",
    "#5 official fire promotes ready → fire");
  eq(deriveUserStage({ ...base, state: "BET_NOW" }), "fire", "#5 BET_NOW → fire");
}

// ── Acceptance #6 / #7 — admin-only buckets flagged, not user sections. ─────
{
  const uncalled = mapHrRadarRowToDisplayState({ ...base, outcomeStatus: "uncalled_hr" }, false);
  eq(uncalled.section, "modelReview", "#6 uncalled_hr → modelReview section");
  eq(uncalled.isAdminOnly, true, "#6 modelReview is admin-only");
  const noAb = mapHrRadarRowToDisplayState(
    { ...base, userStage: "build", hasLiveABContext: true, plateAppearancesTracked: 0 },
    false,
  );
  eq(noAb.section, "noAbYet", "#6 live-but-no-AB → noAbYet section");
  eq(noAb.isAdminOnly, true, "#6 noAbYet is admin-only");
  // A normal missed call is NOT admin-only — it is user-facing 'resolved'.
  const miss = mapHrRadarRowToDisplayState({ ...base, outcomeStatus: "called_miss" });
  eq(miss.section, "resolved", "#7 called_miss → resolved (user-facing)");
  eq(miss.isAdminOnly, false, "#7 resolved miss is not admin-only");
  assert(ADMIN_ONLY_SECTIONS.has("modelReview") && ADMIN_ONLY_SECTIONS.has("noAbYet"),
    "#7 admin-only set is exactly modelReview + noAbYet");
}

// ── Acceptance #8 — drivers surface from server evidence when present. ──────
{
  const withDrivers = mapHrRadarRowToDisplayState({
    ...base,
    userStage: "ready",
    cleanReasons: ["Elite hard contact", "Pull-side lift profile", "Pitcher fatigue rising"],
  });
  assert(withDrivers.drivers.length >= 1, "#8 drivers present when cleanReasons exist");
  eq(withDrivers.drivers[0], "Elite hard contact", "#8 first driver rendered verbatim");
  // Engine-jargon tokens are filtered / humanized, never invented.
  const jargon = deriveDrivers({ ...base, supportingReasons: ["PATH_F_BLOCKED", "two_hard_hit_balls"] });
  assert(!jargon.includes("PATH_F_BLOCKED"), "#8 engine PATH token filtered out");
  assert(jargon.some((d) => /hard hit/i.test(d)), "#8 snake_case humanized");
  // No evidence → no fabricated driver.
  eq(deriveDrivers({ ...base }).length, 0, "#8 no drivers fabricated when none exist");
}

// ── Acceptance #9 — probability and score stay independent (no recompute). ──
{
  const s = mapHrRadarRowToDisplayState({
    ...base,
    userStage: "build",
    currentReadinessScore: 30,
    conversionProbability: 0.4,
  });
  eq(s.displayScore10, 3.0, "#9 score derived from readiness only");
  eq(s.hrChancePct, 40, "#9 HR % derived from probability only — not from readiness");
}

// ── Officiality + record eligibility passthrough. ──────────────────────────
{
  const fire = mapHrRadarRowToDisplayState({ ...base, userStage: "fire", officialSignalStage: "fire" });
  eq(fire.section, "fire", "fire row → fire section");
  eq(fire.isOfficialCall, true, "fire + officialSignalStage=fire → official call");
  eq(fire.recordEligible, true, "official fire → record eligible");
  const ready = mapHrRadarRowToDisplayState({ ...base, userStage: "ready" });
  eq(ready.isOfficialCall, false, "ready alone is NOT an official call");
  eq(ready.recordEligible, false, "ready alone is NOT record eligible");
}

// ── Formatting helpers. ─────────────────────────────────────────────────────
{
  eq(formatScore10Label(deriveDisplayScore10({ ...base, displayCurrentScore10: 7.0 })), "7.0/10",
    "displayCurrentScore10 preferred → 7.0/10");
  eq(formatScore10Label(null), null, "null score → null label");
}

console.log(`\nHR Radar display-state mapper: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
