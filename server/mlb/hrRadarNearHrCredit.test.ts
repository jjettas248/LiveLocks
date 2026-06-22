/**
 * HR Radar hit-rate tightening (2026-06) — near-HR credit + narrowed HR Max
 * Window grading. Pure-function invariants.
 *
 * Locks the changes that turn the 269-miss / 6-hit wall into a precision
 * product:
 *   1. `reachedHrMaxWindow` now grades ONLY the committed fire tier
 *      (officialAlert / actionable / fire) — a bare confidenceTier="strong"
 *      no longer counts as a graded pick.
 *   2. A no-HR HR-Max-Window pick whose batter squared up a genuine near-HR
 *      (barrel / warning-track / elite EV) is credited `called_near_hr` (a
 *      hit-class win) instead of a hard `called_miss`.
 *
 * Run: npx tsx server/mlb/hrRadarNearHrCredit.test.ts
 */

import {
  reachedHrMaxWindow,
  resolveFinalNoHrGrading,
  qualifiesForNearHrCredit,
  CALLED_HIT_OUTCOME_STATUSES,
  deriveHrRadarOutcomeStatus,
  deriveHrRadarSection,
  getCashedFromTierLabel,
  type HrRadarPeakContact,
} from "./hrRadarSection";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function eq<T>(name: string, actual: T, expected: T): void {
  if (actual === expected) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name} — expected=${String(expected)} actual=${String(actual)}`);
    console.log(`  ✗ ${name} — expected=${String(expected)} actual=${String(actual)}`);
  }
}

console.log("\n=== HR Radar Near-HR Credit + Narrowed Grading — Invariant Suite ===\n");

// ── 1. Narrowed reachedHrMaxWindow ─────────────────────────────────────────
console.log("reachedHrMaxWindow — committed fire tier only");

eq("1.1 alertTier=officialAlert → graded",
  reachedHrMaxWindow({ alertTier: "officialAlert" }), true);
eq("1.2 signalState=actionable → graded",
  reachedHrMaxWindow({ signalState: "actionable" }), true);
eq("1.3 signalState=fire → graded",
  reachedHrMaxWindow({ signalState: "fire" }), true);
// The core tightening: a bare "strong"/"elite" confidenceTier no longer grades.
eq("1.4 confidenceTier=strong alone → NOT graded",
  reachedHrMaxWindow({ confidenceTier: "strong" }), false);
eq("1.5 confidenceTier=elite alone → NOT graded",
  reachedHrMaxWindow({ confidenceTier: "elite" }), false);
eq("1.6 confidenceTier=monitor + signalState=live → NOT graded",
  reachedHrMaxWindow({ confidenceTier: "monitor", signalState: "live" }), false);

// ── 2. resolveFinalNoHrGrading honours the narrowed window ──────────────────
console.log("\nresolveFinalNoHrGrading — only committed picks become called_miss");

eq("2.1 officialAlert, no HR → called_miss",
  resolveFinalNoHrGrading({ alertTier: "officialAlert" }), "called_miss");
eq("2.2 strong confidenceTier only, no HR → expired (not a counted miss)",
  resolveFinalNoHrGrading({ confidenceTier: "strong" }), "expired");
eq("2.3 watch/building sub-actionable, no HR → expired",
  resolveFinalNoHrGrading({ confidenceTier: "building", signalState: "live" }), "expired");

// ── 3. qualifiesForNearHrCredit thresholds ──────────────────────────────────
console.log("\nqualifiesForNearHrCredit — squared-up near-HR detection");

eq("3.1 barrel → credit", qualifiesForNearHrCredit({ isBarrel: true }), true);
eq("3.2 nearHrTier=lean → credit", qualifiesForNearHrCredit({ nearHrTier: "lean" }), true);
eq("3.3 distance 385ft → credit", qualifiesForNearHrCredit({ peakDistance: 385 }), true);
eq("3.4 EV 106 + LA 28 → credit",
  qualifiesForNearHrCredit({ peakEv: 106, peakLaunchAngle: 28 }), true);
// Negatives
eq("3.5 EV 106 but LA 50 (popup) → no credit",
  qualifiesForNearHrCredit({ peakEv: 106, peakLaunchAngle: 50 }), false);
eq("3.6 EV 100 + LA 25 (hard but not elite) → no credit",
  qualifiesForNearHrCredit({ peakEv: 100, peakLaunchAngle: 25 }), false);
eq("3.7 distance 360ft (warning track short) → no credit",
  qualifiesForNearHrCredit({ peakDistance: 360 }), false);
eq("3.8 nearHrTier=watch (sub-lean) → no credit",
  qualifiesForNearHrCredit({ nearHrTier: "watch" }), false);
eq("3.9 null / empty contact → no credit",
  qualifiesForNearHrCredit(null), false);
eq("3.10 all-null fields → no credit",
  qualifiesForNearHrCredit({ peakEv: null, peakDistance: null, isBarrel: null }), false);

// ── 4. called_near_hr routes as a hit-class win ─────────────────────────────
console.log("\ncalled_near_hr — hit-class routing");

eq("4.1 called_near_hr ∈ CALLED_HIT_OUTCOME_STATUSES",
  CALLED_HIT_OUTCOME_STATUSES.has("called_near_hr"), true);
eq("4.2 gradingStatus=called_near_hr → outcomeStatus called_near_hr",
  deriveHrRadarOutcomeStatus({ gradingStatus: "called_near_hr" }), "called_near_hr");
eq("4.3 called_near_hr routes to section=cashed",
  deriveHrRadarSection({ gradingStatus: "called_near_hr" }), "cashed");
eq("4.4 tier label = Near-HR",
  getCashedFromTierLabel("called_near_hr"), "Near-HR");

// ── 5. End-to-end grade selection mirror (reconcile logic, pure) ────────────
console.log("\nend-to-end — committed pick at game-final, no HR");

function gradeNoHr(args: {
  alertTier?: string | null; confidenceTier?: string | null; signalState?: string | null;
  contact?: HrRadarPeakContact | null;
}): "called_near_hr" | "called_miss" | "expired" {
  const base = resolveFinalNoHrGrading(args);
  if (base === "called_miss" && qualifiesForNearHrCredit(args.contact)) return "called_near_hr";
  return base;
}

eq("5.1 committed pick + barrel, no HR → called_near_hr",
  gradeNoHr({ alertTier: "officialAlert", contact: { isBarrel: true } }), "called_near_hr");
eq("5.2 committed pick + weak contact, no HR → called_miss",
  gradeNoHr({ alertTier: "officialAlert", contact: { peakEv: 98, peakDistance: 330 } }), "called_miss");
eq("5.3 sub-actionable + barrel, no HR → expired (never a counted pick)",
  gradeNoHr({ confidenceTier: "strong", contact: { isBarrel: true } }), "expired");

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
process.exit(0);
