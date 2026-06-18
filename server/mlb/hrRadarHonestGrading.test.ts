// HR Radar — honest grading (Phase 1, 3-tier ladder) unit tests.
// Verifies that ONLY HR-Max-Window (actionable top tier) signals are graded
// as a counted miss at game-final; Watch/Building context expires instead.
// Run: npx tsx server/mlb/hrRadarHonestGrading.test.ts

import {
  reachedHrMaxWindow,
  reachedHrMaxWindowPeak,
  resolveFinalNoHrGrading,
  deriveHrRadarOutcomeStatus,
  deriveHrRadarSection,
} from "./hrRadarSection";
import {
  classifyHrMaxWindowAtFinal,
  hrMaxWindowClosesByInning,
  HR_MAX_WINDOW_MIN_ELAPSED_INNINGS,
} from "./hrMaxWindow";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.error(`[HR_RADAR_HONEST_GRADING_TEST] FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

// ─── reachedHrMaxWindow — actionable top tier only ─────────────────────────
check("officialAlert reaches HR Max Window", reachedHrMaxWindow({ alertTier: "officialAlert" }));
check("official_alert (snake) reaches HR Max Window", reachedHrMaxWindow({ alertTier: "official_alert" }));
check("confidenceTier strong reaches HR Max Window", reachedHrMaxWindow({ confidenceTier: "strong" }));
check("confidenceTier elite reaches HR Max Window", reachedHrMaxWindow({ confidenceTier: "elite" }));
check("signalState actionable reaches HR Max Window", reachedHrMaxWindow({ signalState: "actionable" }));
check("signalState fire reaches HR Max Window", reachedHrMaxWindow({ signalState: "fire" }));

// ─── Sub-actionable (Watch/Building band) — NOT graded ─────────────────────
check("alertTier prepare is NOT HR Max Window (Building)", !reachedHrMaxWindow({ alertTier: "prepare" }));
check("alertTier watch is NOT HR Max Window", !reachedHrMaxWindow({ alertTier: "watch" }));
check("confidenceTier building is NOT HR Max Window", !reachedHrMaxWindow({ confidenceTier: "building" }));
check("confidenceTier monitor is NOT HR Max Window", !reachedHrMaxWindow({ confidenceTier: "monitor" }));
check("signalState live is NOT HR Max Window", !reachedHrMaxWindow({ signalState: "live" }));
check("presence-only row (all null) is NOT HR Max Window", !reachedHrMaxWindow({}));

// ─── resolveFinalNoHrGrading — terminal grade at game-final, no HR ──────────
check("HR Max Window + no HR → called_miss",
  resolveFinalNoHrGrading({ alertTier: "officialAlert" }) === "called_miss");
check("strong conf + no HR → called_miss",
  resolveFinalNoHrGrading({ confidenceTier: "strong", signalState: "actionable" }) === "called_miss");
check("Building (prepare) + no HR → expired (not counted)",
  resolveFinalNoHrGrading({ alertTier: "prepare", confidenceTier: "building" }) === "expired");
check("Watch (monitor/live) + no HR → expired",
  resolveFinalNoHrGrading({ confidenceTier: "monitor", signalState: "live" }) === "expired");
check("presence-only + no HR → expired",
  resolveFinalNoHrGrading({}) === "expired");

// ─── Section consistency — expired must leave the user-facing MISSED bucket ─
// A row stamped `expired` derives to "unresolved" outcome and must NOT land in
// the missed section (that's the whole point — it was never a pick).
const expiredOutcome = deriveHrRadarOutcomeStatus({ gradingStatus: "expired" });
check("expired gradingStatus → unresolved outcome", expiredOutcome === "unresolved",
  `got ${expiredOutcome}`);
const expiredSection = deriveHrRadarSection({ gradingStatus: "expired" });
check("expired row is NOT in missed section", expiredSection !== "missed",
  `got section=${expiredSection}`);

// ─── Counted miss still routes to missed (regression guard) ────────────────
const missSection = deriveHrRadarSection({ gradingStatus: "called_miss" });
check("called_miss row still routes to missed section", missSection === "missed",
  `got section=${missSection}`);

// ─── Symmetric cash side — only HR Max Window HRs count as wins ─────────────
// Sub-actionable pre-HR signals are stamped `uncalled_hr` and must route to
// the diagnostic bucket (NOT cashed) so they don't inflate the win count.
const uncalledSection = deriveHrRadarSection({ gradingStatus: "uncalled_hr" });
check("uncalled_hr (sub-actionable HR) is NOT cashed", uncalledSection !== "cashed",
  `got section=${uncalledSection}`);
check("uncalled_hr routes to diagnostic", uncalledSection === "diagnostic",
  `got section=${uncalledSection}`);
// HR Max Window cashes still count as wins.
check("called_hit_attack (HR Max Window win) routes to cashed",
  deriveHrRadarSection({ gradingStatus: "called_hit_attack" }) === "cashed");
check("called_hit_ready (HR Max Window win) routes to cashed",
  deriveHrRadarSection({ gradingStatus: "called_hit_ready" }) === "cashed");

// ─── Cash-side gate parity with reachedHrMaxWindow ─────────────────────────
// The gate used by every cash path: reachedHrMaxWindow ? counted : uncalled.
function cashGrade(args: { alertTier?: string | null; confidenceTier?: string | null; signalState?: string | null }): "counted" | "uncalled_hr" {
  return reachedHrMaxWindow(args) ? "counted" : "uncalled_hr";
}
check("HR + officialAlert → counted win", cashGrade({ alertTier: "officialAlert" }) === "counted");
check("HR + prepare/Building → uncalled (not a win)", cashGrade({ alertTier: "prepare" }) === "uncalled_hr");
check("HR + watch → uncalled (not a win)", cashGrade({ alertTier: "watch", confidenceTier: "monitor" }) === "uncalled_hr");

// ─── Fix A — peak-aware HR Max Window (decay-out-of-window grading) ─────────
// reachedHrMaxWindowPeak honors a prior in-window peak even after the current
// tier has decayed below it. Source of truth: peakState BET_NOW + conv floor.
check("peakState BET_NOW + conv 0.14 reached window (peak)",
  reachedHrMaxWindowPeak({ peakState: "BET_NOW", peakConversionProbability: 0.14 }));
check("peakState BET_NOW exactly at 0.12 floor reached window",
  reachedHrMaxWindowPeak({ peakState: "BET_NOW", peakConversionProbability: 0.12 }));
check("peakState BET_NOW but conv below 0.12 floor → NOT reached (over-count guard)",
  !reachedHrMaxWindowPeak({ peakState: "BET_NOW", peakConversionProbability: 0.08 }));
check("peakState PREPARE (not top conviction) → NOT reached",
  !reachedHrMaxWindowPeak({ peakState: "PREPARE", peakConversionProbability: 0.20 }));
check("no peak state → NOT reached",
  !reachedHrMaxWindowPeak({ peakState: null, peakConversionProbability: null }));

// Peak-aware cash gate: an HR whose CURRENT tier decayed to building but which
// genuinely peaked into the window earlier should grade as a counted win
// (Merrill-style). A genuinely thin signal (no peak, weak current) stays
// uncalled (McGonigle-style) — the fix must not erase that correctness.
function cashGradePeakAware(args: {
  alertTier?: string | null; confidenceTier?: string | null; signalState?: string | null;
  peakState?: string | null; peakConversionProbability?: number | null;
}): "counted" | "uncalled_hr" {
  return reachedHrMaxWindow(args) || reachedHrMaxWindowPeak(args) ? "counted" : "uncalled_hr";
}
check("Merrill-style: current building/live but peaked BET_NOW@0.14 → counted",
  cashGradePeakAware({ alertTier: "prepare", confidenceTier: "building", signalState: "live", peakState: "BET_NOW", peakConversionProbability: 0.14 }) === "counted");
check("McGonigle-style: current monitor/watching, no real peak → still uncalled",
  cashGradePeakAware({ confidenceTier: "monitor", signalState: "watching", peakState: "WATCH", peakConversionProbability: 0.056 }) === "uncalled_hr");

// Guard: peak fallback must NOT widen the no-HR terminal grade. The
// resolveFinalNoHrGrading signature accepts no peak fields, so a building/watch
// signal that merely peaked still expires (never a counted called_miss).
check("no-HR grading ignores peak (Building still expires)",
  resolveFinalNoHrGrading({ alertTier: "prepare", confidenceTier: "building" }) === "expired");

// ─── PA-bounded HR Max Window (slice 3) ────────────────────────────────────
// An HR Max Window miss only counts when the batter had the window's worth of
// opportunity. A signal fired in the game's final frame → expired (cut short).
check("signal in inning 3, game ends inning 9 → called_miss (window played out)",
  classifyHrMaxWindowAtFinal({ signalInning: 3, finalInning: 9 }) === "called_miss");
check("signal in inning 9, game ends inning 9 → expired (no room left)",
  classifyHrMaxWindowAtFinal({ signalInning: 9, finalInning: 9 }) === "expired");
check("signal one inning before final → called_miss (MIN_ELAPSED met)",
  classifyHrMaxWindowAtFinal({ signalInning: 8, finalInning: 8 + HR_MAX_WINDOW_MIN_ELAPSED_INNINGS }) === "called_miss");
check("null signalInning fails safe to called_miss (never drop a loss)",
  classifyHrMaxWindowAtFinal({ signalInning: null, finalInning: 9 }) === "called_miss");
check("null finalInning fails safe to called_miss",
  classifyHrMaxWindowAtFinal({ signalInning: 5, finalInning: null }) === "called_miss");
check("extra-innings signal (inning 10) still grades when game runs long",
  classifyHrMaxWindowAtFinal({ signalInning: 10, finalInning: 12 }) === "called_miss");

// Window descriptor for the UI.
check("window closes-by inning is signal + budget*innings-per-PA",
  hrMaxWindowClosesByInning(4) === 4 + 2 * 2);
check("window descriptor null-safe", hrMaxWindowClosesByInning(null) === null);

console.log(`[HR_RADAR_HONEST_GRADING_TEST] passed=${pass} failed=${fail}`);
if (fail > 0) process.exit(1);
console.log("[HR_RADAR_HONEST_GRADING_TEST] OK");
