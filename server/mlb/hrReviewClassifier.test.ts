// HR Review Classifier — unit tests for the pre-HR review bucket taxonomy.
// Run: npx tsx server/mlb/hrReviewClassifier.test.ts

import {
  classifyHrReview,
  type HrReviewBucket,
  type HrReviewClassifierInput,
} from "./hrReviewClassifier";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function expectBucket(label: string, input: HrReviewClassifierInput, expected: HrReviewBucket): void {
  const { bucket } = classifyHrReview(input);
  if (bucket === expected) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    failures.push(`${label} — expected=${expected} actual=${bucket}`);
    console.log(`  ✗ ${label} — expected=${expected} actual=${bucket}`);
  }
}

function expectNotBucket(label: string, input: HrReviewClassifierInput, notExpected: HrReviewBucket): void {
  const { bucket } = classifyHrReview(input);
  if (bucket !== notExpected) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    failures.push(`${label} — should NOT be ${notExpected}`);
    console.log(`  ✗ ${label} — should NOT be ${notExpected}`);
  }
}

function assert(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const HR_MS = 1_000_000;
// A "complete data quality" base so non-data-quality fixtures aren't diverted to
// insufficient_review_data. Provides HR identity, player identity, signal state.
const base = (): HrReviewClassifierInput => ({
  playerId: "p1",
  playerName: "Test Player",
  hrEndTimeMs: HR_MS,
  hrInning: 5,
  hrAtBatIndex: 4,
  hrPlayId: "play-1",
  canonicalStage: "watch",
  preHrResolverStatus: "complete",
});

console.log("=== HR Review Classifier ===");

// 1. existing called_hit → called_hit
expectBucket("1. existing called_hit", { ...base(), existingOutcomeStatus: "called_hit" }, "called_hit");

// 2. Ready before HR → called_hit
expectBucket("2. firstReadyAt before HR", { ...base(), firstReadyAtMs: HR_MS - 5000 }, "called_hit");

// 3. Fire before HR → called_hit
expectBucket("3. firstFireAt before HR", { ...base(), firstFireAtMs: HR_MS - 5000 }, "called_hit");

// 4. conversion ≥0.12 but no surfaced official signal → NOT called_hit
expectNotBucket(
  "4. conversion 0.18, no surfaced signal → not called_hit",
  { ...base(), peakConversionProbability: 0.18 },
  "called_hit",
);

// 5. signal at/after HR → late_signal
expectBucket("5. qualifying signal at/after HR", { ...base(), firstQualifyingSignalAtMs: HR_MS + 1000 }, "late_signal");

// 6. post-HR fallback → late_signal
expectBucket("6. matchMethod post_hr_fallback", { ...base(), matchMethod: "post_hr_fallback" }, "late_signal");

// 7. bus pre-HR record + matchedBeforeHr false → attribution_miss
expectBucket(
  "7. bus pre-HR record + matchedBeforeHr false",
  { ...base(), signalBusHadPreHrRecord: true, matchedBeforeHr: false },
  "attribution_miss",
);

// 8. bus record only after HR (not flagged pre-HR) → NOT attribution_miss
expectNotBucket(
  "8. bus record only after HR → not attribution_miss",
  { ...base(), signalBusHadPreHrRecord: false, matchedBeforeHr: false },
  "attribution_miss",
);

// 9. both hrr and home_runs candidate IDs checked (snapshot carries checkedSignalIds)
{
  const ids = ["mlb:g:p1:hrr:OVER", "mlb:g:p1:home_runs:OVER"];
  const { snapshot } = classifyHrReview({ ...base(), checkedSignalIds: ids });
  assert(
    "9. checkedSignalIds carries both hrr and home_runs",
    snapshot.checkedSignalIds.includes("mlb:g:p1:hrr:OVER") &&
      snapshot.checkedSignalIds.includes("mlb:g:p1:home_runs:OVER"),
  );
}

// 10. same-PA with one weak prior AB → same_pa_hr_no_prior_live_signal
expectBucket(
  "10. same-PA, one weak prior AB, HR first HR-shaped",
  {
    ...base(),
    hrEventWasBarrelOrHrShaped: true,
    preHrAbs: [{ abIndex: 3, exitVelocity: 78, launchAngle: 24, distance: 258, outcome: "out" }],
  },
  "same_pa_hr_no_prior_live_signal",
);

// 11. early inning, insufficient ABs, no context → early_window_hr
expectBucket(
  "11. early window HR",
  { ...base(), hrInning: 1, hrAtBatIndex: 1, preHrAbs: [{ abIndex: 0, exitVelocity: 80, launchAngle: 10 }] },
  "early_window_hr",
);

// 12. Greene: Watch peak 5.4, current 3.6 → live_promotion_miss
expectBucket(
  "12. Greene — peak 5.4 watch, decayed to 3.6",
  {
    ...base(),
    peakState: "WATCH",
    peakReadinessScore: 5.4,
    currentReadinessScore: 3.6,
    preHrAbs: [
      { abIndex: 1, exitVelocity: 97.7, launchAngle: 50, distance: 277, outcome: "out" },
      { abIndex: 2, outcome: "walk" },
    ],
  },
  "live_promotion_miss",
);

// 13. Freeman: pitcher fatigue + HR-prone + bullpen depleted, no pre-HR barrel → context_miss
expectBucket(
  "13. Freeman — pitcher/context driven, no pre-HR barrel",
  {
    ...base(),
    peakState: "BUILDING",
    peakReadinessScore: 2.0,
    hrPronePitcher: true,
    bullpenDepleted: true,
    pitcherCollapsing: true,
    preHrAbs: [
      { abIndex: 1, outcome: "strikeout" },
      { abIndex: 2, exitVelocity: 83.3, launchAngle: 46, distance: 240, outcome: "out" },
    ],
  },
  "context_miss",
);

// 14. Duran: weak prior AB, HR first barrel → same_pa_hr_no_prior_live_signal
expectBucket(
  "14. Duran — weak prior AB then HR barrel",
  {
    ...base(),
    hrInning: 4,
    hrAtBatIndex: 2,
    hrEventWasBarrelOrHrShaped: true,
    peakState: "WATCH",
    peakReadinessScore: 3.0,
    preHrAbs: [{ abIndex: 0, exitVelocity: 78, launchAngle: 24, distance: 258, outcome: "out" }],
  },
  "same_pa_hr_no_prior_live_signal",
);

// 15. hard-hit grounder before HR does NOT create HR live evidence → not live_promotion_miss
expectNotBucket(
  "15. hard-hit grounder (100.7/-2°) not HR evidence",
  {
    ...base(),
    peakState: "WATCH",
    peakReadinessScore: 2.0,
    preHrAbs: [{ abIndex: 3, exitVelocity: 100.7, launchAngle: -2, distance: 30, outcome: "out" }],
  },
  "live_promotion_miss",
);

// 16. HR contact accidentally in preHrAbs is dropped (abIndex === hrAtBatIndex)
{
  const dirty: HrReviewClassifierInput = {
    ...base(),
    hrAtBatIndex: 4,
    hrEventWasBarrelOrHrShaped: true,
    preHrAbs: [
      { abIndex: 4, exitVelocity: 107, launchAngle: 28, distance: 420, isBarrel: true, outcome: "home_run" },
    ],
  };
  const { snapshot, bucket } = classifyHrReview(dirty);
  assert(
    "16. HR's own AB dropped from pre-HR evidence",
    snapshot.completedAbsBeforeHr === 0 &&
      !snapshot.hadBarrelBeforeHr &&
      !snapshot.hadHrCandidateContactBeforeHr &&
      bucket === "same_pa_hr_no_prior_live_signal",
    `completedAbs=${snapshot.completedAbsBeforeHr} barrel=${snapshot.hadBarrelBeforeHr} bucket=${bucket}`,
  );
}

// 17. missing HR timestamp → insufficient_review_data
expectBucket(
  "17. missing HR timestamp",
  { playerId: "p1", hrAtBatIndex: 4, canonicalStage: "watch", preHrResolverStatus: "complete", hrEndTimeMs: null },
  "insufficient_review_data",
);

// 18. ambiguous event ordering → insufficient_review_data
expectBucket(
  "18. ambiguous pre-HR ordering",
  { ...base(), preHrResolverStatus: "ambiguous" },
  "insufficient_review_data",
);

// 19. empty input → insufficient_review_data
expectBucket("19. empty input", {}, "insufficient_review_data");

// 20. clean no-evidence with complete data → true_uncalled_hr
expectBucket(
  "20. clean no-evidence, complete data",
  {
    ...base(),
    peakState: "WATCH",
    peakReadinessScore: 1.0,
    preHrAbs: [
      { abIndex: 1, exitVelocity: 70, launchAngle: 5 },
      { abIndex: 2, exitVelocity: 68, launchAngle: 12 },
    ],
  },
  "true_uncalled_hr",
);

// 21. existing called_hit with missing hrEndTimeMs → called_hit (authoritative short-circuit)
expectBucket(
  "21. authoritative called_hit overrides missing timestamp",
  { existingOutcomeStatus: "called_hit", hrEndTimeMs: null },
  "called_hit",
);

// 22. existing late_signal with missing hrEndTimeMs → late_signal
expectBucket(
  "22. authoritative late_signal overrides missing timestamp",
  { existingOutcomeStatus: "late_signal", hrEndTimeMs: null },
  "late_signal",
);

// 23. existing early_hr_insufficient_sample → early_window_hr
expectBucket(
  "23. early_hr_insufficient_sample → early_window_hr",
  { existingOutcomeStatus: "early_hr_insufficient_sample" },
  "early_window_hr",
);

// 24. missing pre-HR source AND missing signal history → insufficient_review_data (missing)
{
  const input: HrReviewClassifierInput = {
    playerId: "p1",
    hrEndTimeMs: HR_MS,
    hrAtBatIndex: 4,
    preHrResolverStatus: "missing",
    // no signal state at all
  };
  const { bucket, snapshot } = classifyHrReview(input);
  assert(
    "24. missing source + missing signal history → insufficient + dataQuality missing",
    bucket === "insufficient_review_data" && snapshot.dataQuality === "missing",
    `bucket=${bucket} dq=${snapshot.dataQuality}`,
  );
}

// 25. player_game_only with NO pre-HR signal evidence → NOT attribution_miss
expectNotBucket(
  "25. player_game_only without pre-HR signal → not attribution_miss",
  { ...base(), matchMethod: "player_game_only", signalBusHadPreHrRecord: false, lifecycleHadPreHrRecord: false },
  "attribution_miss",
);

// 26. player_game_only WITH pre-HR signal evidence → attribution_miss
expectBucket(
  "26. player_game_only with pre-HR signal → attribution_miss",
  { ...base(), matchMethod: "player_game_only", lifecycleHadPreHrRecord: true },
  "attribution_miss",
);

// 27. powerProfile alone (no pitcher/env/pregame) → NOT context_miss
expectNotBucket(
  "27. powerProfile alone → not context_miss",
  { ...base(), peakState: "WATCH", peakReadinessScore: 1.0, powerProfile: true, preHrAbs: [{ abIndex: 3, exitVelocity: 70, launchAngle: 5 }] },
  "context_miss",
);

// 28. powerProfile + HR-prone pitcher → context_miss
expectBucket(
  "28. powerProfile + HR-prone pitcher → context_miss",
  { ...base(), peakState: "WATCH", peakReadinessScore: 1.0, powerProfile: true, hrPronePitcher: true, preHrAbs: [{ abIndex: 3, exitVelocity: 70, launchAngle: 5 }] },
  "context_miss",
);

// 29. engineGeneratedBeforeHr but NOT surfaced → NOT attribution_miss
expectNotBucket(
  "29. engineGeneratedBeforeHr only (not surfaced) → not attribution_miss",
  { ...base(), engineGeneratedBeforeHr: true, signalBusHadPreHrRecord: false, matchedBeforeHr: false },
  "attribution_miss",
);

// 30. surfacedAt before HR (signalBusHadPreHrRecord) with matchedBeforeHr=false → attribution_miss
expectBucket(
  "30. surfaced pre-HR bus record + matchedBeforeHr false → attribution_miss",
  { ...base(), signalBusHadPreHrRecord: true, matchedBeforeHr: false },
  "attribution_miss",
);

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
