/**
 * HR Miss Diagnostic Payload Generator — invariant test.
 *
 * Locks the pure builders in hrMissDiagnostics.ts: authoritative-grade →
 * category mapping (never re-grades), the FIRE-only fired/ready split on
 * called_miss rows, diagnosticsSnapshot extraction (scoreContract /
 * stageContract / abContext / hrReview), timeline ordering + truncation,
 * aggregate summary math, and the markdown LLM-prompt rendering.
 *
 * Run: npx tsx server/mlb/hrMissDiagnostics.test.ts
 */

import {
  ALL_MISS_CATEGORIES,
  DEFAULT_MISS_CATEGORIES,
  DEFAULT_ANALYSIS_INSTRUCTIONS,
  buildHrMissDiagnosticPayload,
  buildHrMissDiagnosticRecord,
  buildHrMissDiagnosticSummary,
  deriveMissCategory,
  missKindOf,
  renderHrMissDiagnosticPayloadAsMarkdown,
  type HrMissAlertRowInput,
  type HrMissSignalEventInput,
} from "./hrMissDiagnostics";
import { FIRE_BET_NOW_CONV_THRESHOLD } from "./hrRadarSection";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq<T>(name: string, actual: T, expected: T): void {
  assert(name, actual === expected, `expected=${String(expected)} actual=${String(actual)}`);
}

function baseRow(overrides: Partial<HrMissAlertRowInput> = {}): HrMissAlertRowInput {
  return {
    id: "alert-1",
    sessionDate: "2026-06-30",
    gameId: "g1",
    playerId: "p1",
    playerName: "Test Slugger",
    team: "NYY",
    gradingStatus: "called_miss",
    alertPath: "PATH_C",
    ...overrides,
  };
}

console.log("\n=== HR Miss Diagnostic Payload Generator — Invariant Suite ===\n");

// ── deriveMissCategory — authoritative grade → category, never re-grades ────
console.log("deriveMissCategory — grade → category mapping");

eq("1. called_miss + FAST_PROMOTE_ELITE path → fired_miss",
  deriveMissCategory(baseRow({ alertPath: "FAST_PROMOTE_ELITE" })), "fired_miss");

eq("2. called_miss + peakConv above BET_NOW band → fired_miss",
  deriveMissCategory(baseRow({
    diagnosticsSnapshot: { scoreContract: { peakConversionProbability: FIRE_BET_NOW_CONV_THRESHOLD + 0.01 } },
  })), "fired_miss");

eq("3. called_miss + peakConv below BET_NOW band → ready_only_miss",
  deriveMissCategory(baseRow({
    diagnosticsSnapshot: { scoreContract: { peakConversionProbability: 0.09 } },
  })), "ready_only_miss");

eq("4. called_miss + no scoreContract (conservative) → ready_only_miss",
  deriveMissCategory(baseRow({ diagnosticsSnapshot: null })), "ready_only_miss");

eq("5. uncalled_hr → uncalled_hr",
  deriveMissCategory(baseRow({ gradingStatus: "uncalled_hr" })), "uncalled_hr");

eq("6. late_signal → late_signal",
  deriveMissCategory(baseRow({ gradingStatus: "late_signal" })), "late_signal");

eq("7. early_hr_no_window → early_window_exempt",
  deriveMissCategory(baseRow({ gradingStatus: "early_hr_no_window" })), "early_window_exempt");

eq("8. early_hr_insufficient_sample → early_window_exempt",
  deriveMissCategory(baseRow({ gradingStatus: "early_hr_insufficient_sample" })), "early_window_exempt");

eq("9. called_hit is NOT a miss → null",
  deriveMissCategory(baseRow({ gradingStatus: "called_hit" })), null);

eq("10. active row is NOT a miss → null",
  deriveMissCategory(baseRow({ gradingStatus: "active" })), null);

eq("11. expired (sub-actionable, uncounted) is NOT a miss → null",
  deriveMissCategory(baseRow({ gradingStatus: "expired" })), null);

// ── missKindOf ───────────────────────────────────────────────────────────────
console.log("\nmissKindOf — category → precision/recall family");
eq("12. fired_miss → false_positive", missKindOf("fired_miss"), "false_positive");
eq("13. ready_only_miss → false_positive", missKindOf("ready_only_miss"), "false_positive");
eq("14. uncalled_hr → false_negative", missKindOf("uncalled_hr"), "false_negative");
eq("15. late_signal → false_negative", missKindOf("late_signal"), "false_negative");
eq("16. early_window_exempt → exempt", missKindOf("early_window_exempt"), "exempt");

// ── buildHrMissDiagnosticRecord — extraction contract ────────────────────────
console.log("\nbuildHrMissDiagnosticRecord — extraction");

eq("17. non-miss row → null record",
  buildHrMissDiagnosticRecord(baseRow({ gradingStatus: "called_hit" })), null);

const richRow = baseRow({
  gradingStatus: "called_miss",
  alertPath: "FAST_PROMOTE_ELITE",
  gradingReason: "no HR at game final",
  matchMethod: "none",
  peakReadinessScore: "62.5", // Drizzle numeric() → string
  rawPreCapScore: "70",
  finalScore: "62.5",
  capReason: "degraded_contact_cap",
  suppressionReason: "below_threshold_with_degraded_data",
  missingInputs: ["missing_statcast"],
  dataQualityFlags: ["degraded"],
  confidence: "0.6",
  triggerTags: ["barrel", "pitcher-fade"],
  detectedInning: 3,
  hitInning: null,
  signalDetectedAt: new Date("2026-06-30T22:15:00Z"),
  contactSnapshot: { peakEv: 108.2, isBarrel: true },
  diagnosticsSnapshot: {
    scoreContract: {
      buildScore: 7.2,
      conversionProbabilityRaw: 0.11,
      conversionProbability: 0.16,
      peakConversionProbability: 0.18,
    },
    stageContract: {
      currentCanonicalStage: "attack",
      dynamicState: "BET_NOW",
      consecutivePromoteTicks: 3,
    },
    abContext: { plateAppearancesTracked: 3, hasLiveABContext: true },
    hrReview: {
      bucket: "live_promotion_miss",
      reason: "meaningful pre-HR live evidence",
      snapshot: {
        dataQuality: "complete",
        preHrPeakStage: "build",
        preHrPeakScore10: 6.5,
        completedAbsBeforeHr: 2,
        hadNearHrBeforeHr: true,
        hadBarrelBeforeHr: true,
        hadHardHitBeforeHr: true,
        hadPregameWatch: false,
      },
    },
  },
});

const rich = buildHrMissDiagnosticRecord(richRow, [], { blockedGate: "below_bet_now" })!;
eq("18. rich called_miss on fast-fire path → fired_miss", rich.category, "fired_miss");
eq("19. missKind stamped false_positive", rich.missKind, "false_positive");
eq("20. fireCommitted true via FAST_PROMOTE_ELITE", rich.grading.fireCommitted, true);
eq("21. numeric-string peakReadiness coerced", rich.scores.peakReadiness, 62.5);
eq("22. rawPreCapScore coerced", rich.scores.rawPreCapScore, 70);
eq("23. capReason carried", rich.scores.capReason, "degraded_contact_cap");
eq("24. confidence coerced", rich.scores.confidence, 0.6);
eq("25. scoreContract.peakConversionProbability extracted", rich.engine.peakConversionProbability, 0.18);
eq("26. scoreContract.buildScore extracted", rich.engine.buildScore, 7.2);
eq("27. stageContract.dynamicState extracted", rich.engine.dynamicState, "BET_NOW");
eq("28. stageContract.canonicalStage extracted", rich.engine.canonicalStage, "attack");
eq("29. consecutivePromoteTicks extracted", rich.engine.consecutivePromoteTicks, 3);
eq("30. abContext.plateAppearancesTracked extracted", rich.engine.plateAppearancesTracked, 3);
eq("31. abContext.hasLiveABContext extracted", rich.engine.hasLiveABContext, true);
eq("32. suppressionReason carried", rich.dataQuality.suppressionReason, "below_threshold_with_degraded_data");
eq("33. missingInputs carried", rich.dataQuality.missingInputs.join(","), "missing_statcast");
eq("34. triggerTags carried", rich.evidence.triggerTags.join(","), "barrel,pitcher-fade");
eq("35. contactSnapshot carried", (rich.evidence.contactSnapshot as any)?.peakEv, 108.2);
eq("36. hrReview bucket extracted", rich.review?.bucket ?? null, "live_promotion_miss");
eq("37. hrReview preHrPeakStage extracted", rich.review?.preHrPeakStage ?? null, "build");
eq("38. hrReview hadBarrelBeforeHr extracted", rich.review?.hadBarrelBeforeHr ?? null, true);
eq("39. blockedGate extra carried", rich.grading.blockedGate, "below_bet_now");
eq("40. signalDetectedAt ISO-stamped", rich.timing.signalDetectedAt, "2026-06-30T22:15:00.000Z");

const bare = buildHrMissDiagnosticRecord(baseRow({ gradingStatus: "uncalled_hr", diagnosticsSnapshot: null }))!;
eq("41. bare uncalled_hr — review is null when never stamped", bare.review, null);
eq("42. bare row — missingInputs defaults to empty array", bare.dataQuality.missingInputs.length, 0);
eq("43. bare row — blockedGate defaults to null (never guessed)", bare.grading.blockedGate, null);
eq("44. bare row — peakConversionProbability null on absent contract", bare.engine.peakConversionProbability, null);

// ── timeline ordering + truncation ───────────────────────────────────────────
console.log("\ntimeline — ordering + truncation");

const mkEvent = (i: number): HrMissSignalEventInput => ({
  eventType: `evt_${i}`,
  signalState: "watch",
  score: String(i),
  detectedAt: new Date(Date.UTC(2026, 5, 30, 20, i, 0)),
  inning: 1 + Math.floor(i / 3),
  half: "top",
});

const shuffled = [mkEvent(3), mkEvent(1), mkEvent(2)];
const ordered = buildHrMissDiagnosticRecord(richRow, shuffled)!;
eq("45. timeline sorted chronologically", ordered.timeline.map((e) => e.eventType).join(","), "evt_1,evt_2,evt_3");
eq("46. timeline score coerced from numeric string", ordered.timeline[0].score, 1);
eq("47. short timeline not truncated", ordered.timelineTruncated, 0);

const many = Array.from({ length: 15 }, (_, i) => mkEvent(i));
const truncated = buildHrMissDiagnosticRecord(richRow, many)!;
eq("48. long timeline capped at 12", truncated.timeline.length, 12);
eq("49. truncation count reported", truncated.timelineTruncated, 3);
eq("50. earliest events preserved after truncation", truncated.timeline[0].eventType, "evt_0");
eq("51. latest event preserved after truncation", truncated.timeline[11].eventType, "evt_14");
eq("52. truncation keeps first two then most recent tail", truncated.timeline[2].eventType, "evt_5");

// ── summary math ─────────────────────────────────────────────────────────────
console.log("\nbuildHrMissDiagnosticSummary — aggregate math");

const recA = buildHrMissDiagnosticRecord(richRow, [])!; // fired_miss, peak 62.5 / conv 0.18
const recB = buildHrMissDiagnosticRecord(
  baseRow({
    gameId: "g2",
    playerId: "p2",
    gradingStatus: "called_miss",
    alertPath: "PATH_C",
    peakReadinessScore: 40,
    diagnosticsSnapshot: { scoreContract: { peakConversionProbability: 0.10 } },
  }),
)!; // ready_only_miss
const recC = buildHrMissDiagnosticRecord(
  baseRow({ gameId: "g3", playerId: "p3", gradingStatus: "uncalled_hr", missingInputs: ["missing_statcast", "missing_batter_power"] }),
  [],
  { blockedGate: "no_alert" },
)!;
const recD = buildHrMissDiagnosticRecord(
  baseRow({ gameId: "g4", playerId: "p4", gradingStatus: "early_hr_no_window" }),
)!;

const summary = buildHrMissDiagnosticSummary([recA, recB, recC, recD]);
eq("53. totalRecords", summary.totalRecords, 4);
eq("54. falsePositives = fired + ready_only", summary.falsePositives, 2);
eq("55. falseNegatives = uncalled", summary.falseNegatives, 1);
eq("56. exempt counted separately", summary.exempt, 1);
eq("57. byCategory fired_miss", summary.byCategory["fired_miss"], 1);
eq("58. byCategory ready_only_miss", summary.byCategory["ready_only_miss"], 1);
eq("59. byReviewBucket from stamped review", summary.byReviewBucket["live_promotion_miss"], 1);
eq("60. byMissingInput counts each input", summary.byMissingInput["missing_batter_power"], 1);
eq("61. byBlockedGate counts tracer gates", summary.byBlockedGate["no_alert"], 1);
eq("62. avg FP peak readiness = (62.5+40)/2", summary.avgPeakReadinessOnFalsePositives, 51.25);
eq("63. avg FP peak conversion = (0.18+0.10)/2", summary.avgPeakConversionOnFalsePositives, 0.14);

// ── payload builder + markdown rendering ─────────────────────────────────────
console.log("\npayload + markdown rendering");

const payload = buildHrMissDiagnosticPayload([recA, recB, recC], {
  generatedAt: "2026-07-01T12:00:00.000Z",
  days: 7,
  fromDateET: "2026-06-24",
  toDateET: "2026-07-01",
  requestedCategories: [...DEFAULT_MISS_CATEGORIES],
  totalMissesInWindow: 10,
  recordLimit: 3,
});
eq("64. truncated flag when window total exceeds records", payload.truncated, true);
assert("65. engineVersion stamped from goldmaster", payload.engineVersion.length > 0);
eq("66. default analysis instructions applied", payload.analysisInstructions, DEFAULT_ANALYSIS_INSTRUCTIONS);
eq("67. FIRE threshold surfaced in model context",
  payload.modelContext.thresholds.fireBetNowConversionThreshold, FIRE_BET_NOW_CONV_THRESHOLD);
eq("68. summary embedded", payload.summary.totalRecords, 3);
eq("69. category vocabulary is closed (5 categories)", ALL_MISS_CATEGORIES.length, 5);
eq("70. default scope excludes exempt", DEFAULT_MISS_CATEGORIES.includes("early_window_exempt" as any), false);

const md = renderHrMissDiagnosticPayloadAsMarkdown(payload);
assert("71. markdown has title", md.startsWith("# LiveLocks HR Radar — Miss Diagnostic Payload"));
assert("72. markdown states truncation", md.includes("3 of 10 misses included"));
assert("73. markdown contains task section", md.includes("## Task"));
assert("74. markdown contains records section", md.includes("## Miss records (3)"));
assert("75. markdown embeds record identity", md.includes("\"playerName\": \"Test Slugger\""));

const jsonBlocks = md.match(/```json\n([\s\S]*?)\n```/g) ?? [];
eq("76. markdown carries 3 fenced JSON blocks", jsonBlocks.length, 3);
let allParse = true;
for (const block of jsonBlocks) {
  try {
    JSON.parse(block.replace(/^```json\n/, "").replace(/\n```$/, ""));
  } catch {
    allParse = false;
  }
}
assert("77. every fenced JSON block parses back", allParse);

// ── read-only guarantee ──────────────────────────────────────────────────────
console.log("\nread-only guarantee");
const frozen = baseRow({ gradingStatus: "uncalled_hr", triggerTags: ["a"], diagnosticsSnapshot: { scoreContract: {} } });
const snapshotBefore = JSON.stringify(frozen);
buildHrMissDiagnosticRecord(frozen, [mkEvent(1)]);
eq("78. builder never mutates its input row", JSON.stringify(frozen), snapshotBefore);

// ── Results ──────────────────────────────────────────────────────────────────
console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
