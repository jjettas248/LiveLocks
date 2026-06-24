/**
 * HR Radar FIRE-only official grading — invariant test.
 *
 * Locks the 2026-06 false-call reduction: only a row that reached the
 * user-facing FIRE commitment may resolve as a counted `called_miss`. A row the
 * alert-path engine surfaced as `officialAlert` whose dynamic conviction never
 * crossed the BET_NOW band (and that did not take the FAST_PROMOTE_ELITE fire
 * path) is only user-stage READY — high-watch context, never an official call —
 * and must NOT pollute the official HR record.
 *
 * Run: npx tsx server/mlb/hrRadarFireOnlyGrading.test.ts
 */

import {
  reachedFireCommitment,
  resolveFinalNoHrGrading,
  reachedHrMaxWindow,
  FIRE_BET_NOW_CONV_THRESHOLD,
} from "./hrRadarSection";

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

console.log("\n=== HR Radar FIRE-only Official Grading — Invariant Suite ===\n");

// ── reachedFireCommitment — direct coverage ───────────────────────────────
console.log("reachedFireCommitment — FIRE proxy from persisted data");

// FAST_PROMOTE_ELITE always qualifies (the engine's fast-fire path).
eq("1. FAST_PROMOTE_ELITE + null conv → fire-committed",
  reachedFireCommitment({ alertPath: "FAST_PROMOTE_ELITE", peakConversionProbability: null }), true);

// Peak conversion crossed the BET_NOW band → fire-committed.
eq("2. peakConv 0.20 (>= 0.14 BET_NOW band) → fire-committed",
  reachedFireCommitment({ alertPath: "PATH_C", peakConversionProbability: 0.20 }), true);

// Peak conversion exactly at the threshold → fire-committed (inclusive).
eq("3. peakConv at threshold → fire-committed",
  reachedFireCommitment({ alertPath: "PATH_C", peakConversionProbability: FIRE_BET_NOW_CONV_THRESHOLD }), true);

// READY-only: officialAlert-tier path (PATH_C) but dynamic conviction below the
// BET_NOW band → NOT fire-committed.
eq("4. PATH_C + peakConv 0.09 (< 0.14) → NOT fire-committed (READY-only)",
  reachedFireCommitment({ alertPath: "PATH_C", peakConversionProbability: 0.09 }), false);

// Missing peak conversion + non-elite path → conservative: NOT fire-committed.
eq("5. PATH_C + null peakConv → NOT fire-committed (conservative)",
  reachedFireCommitment({ alertPath: "PATH_C", peakConversionProbability: null }), false);

eq("6. null alertPath + null peakConv → NOT fire-committed",
  reachedFireCommitment({ alertPath: null, peakConversionProbability: null }), false);

// ── Interaction with resolveFinalNoHrGrading (the gradeable-tier gate) ─────
// resolveFinalNoHrGrading marks the Attack/HR-Max-Window tier; the storage
// reconcile then demotes any non-FIRE-committed called_miss to `expired`. This
// suite documents the two-gate composition the reconcile relies on.
console.log("\nresolveFinalNoHrGrading + reachedFireCommitment composition");

// An officialAlert row reaches the gradeable window...
eq("7. officialAlert reaches HR Max Window (gradeable tier)",
  reachedHrMaxWindow({ alertTier: "officialAlert", confidenceTier: null, signalState: "actionable" }), true);
eq("8. officialAlert no-HR → resolveFinalNoHrGrading = called_miss (pre-FIRE-gate)",
  resolveFinalNoHrGrading({ alertTier: "officialAlert", confidenceTier: null, signalState: "actionable" }), "called_miss");

// ...but if it never reached FIRE (READY-only, low peak conv, non-elite path),
// the reconcile FIRE gate demotes that called_miss to expired.
const readyOnlyFireCommitted = reachedFireCommitment({ alertPath: "PATH_C", peakConversionProbability: 0.09 });
eq("9. that same READY-only row is NOT fire-committed → reconcile demotes to expired",
  readyOnlyFireCommitted, false);

// A genuine FIRE row (BET_NOW band) keeps its called_miss.
const fireCommitted = reachedFireCommitment({ alertPath: "PATH_C", peakConversionProbability: 0.18 });
eq("10. a genuine FIRE row (peakConv 0.18) IS fire-committed → called_miss stands",
  fireCommitted, true);

// Watch/Building rows were never gradeable in the first place.
eq("11. prepare/building no-HR → expired (never a pick, pre-FIRE-gate)",
  resolveFinalNoHrGrading({ alertTier: "prepare", confidenceTier: "building", signalState: "live" }), "expired");

// ── WIN side (HR occurred) — symmetric FIRE gate ───────────────────────────
// The cashed write sites compute `officialCall = reachedHrMaxWindow && reachedFireCommitment`
// and stamp a counted called_hit only when officialCall is true; otherwise the
// HR is `uncalled_hr` (diagnostic, excluded from the official win count). This
// suite models that exact composition.
console.log("\nWIN side — officialCall = reachedHrMaxWindow && reachedFireCommitment");

function officialCall(args: {
  alertTier?: string | null; signalState?: string | null;
  alertPath?: string | null; peakConversionProbability?: number | null;
}): "called_hit" | "uncalled_hr" {
  const reachedMax = reachedHrMaxWindow({ alertTier: args.alertTier, confidenceTier: null, signalState: args.signalState });
  const fire = reachedFireCommitment({ alertPath: args.alertPath, peakConversionProbability: args.peakConversionProbability });
  return reachedMax && fire ? "called_hit" : "uncalled_hr";
}

// FIRE-committed officialAlert HR → counted called_hit.
eq("12. officialAlert + peakConv 0.20 + HR → called_hit",
  officialCall({ alertTier: "officialAlert", signalState: "actionable", alertPath: "PATH_C", peakConversionProbability: 0.20 }), "called_hit");

// READY-only officialAlert (low peak conv, non-elite) HR → uncalled_hr (NOT counted).
eq("13. officialAlert + peakConv 0.09 + HR → uncalled_hr (READY-only, not counted)",
  officialCall({ alertTier: "officialAlert", signalState: "actionable", alertPath: "PATH_C", peakConversionProbability: 0.09 }), "uncalled_hr");

// FAST_PROMOTE_ELITE officialAlert HR → counted even with null peak conv.
eq("14. officialAlert + FAST_PROMOTE_ELITE + null conv + HR → called_hit",
  officialCall({ alertTier: "officialAlert", signalState: "actionable", alertPath: "FAST_PROMOTE_ELITE", peakConversionProbability: null }), "called_hit");

// Sub-actionable (watch/building) HR → uncalled_hr regardless of conv.
eq("15. prepare/building + high conv + HR → uncalled_hr (never reached Max Window)",
  officialCall({ alertTier: "prepare", signalState: "live", alertPath: "PATH_C", peakConversionProbability: 0.20 }), "uncalled_hr");

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
process.exit(0);
