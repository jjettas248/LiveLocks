// HR Radar — honest grading (Phase 1, 3-tier ladder) unit tests.
// Verifies that ONLY HR-Max-Window (actionable top tier) signals are graded
// as a counted miss at game-final; Watch/Building context expires instead.
// Run: npx tsx server/mlb/hrRadarHonestGrading.test.ts

import {
  reachedHrMaxWindow,
  resolveFinalNoHrGrading,
  deriveHrRadarOutcomeStatus,
  deriveHrRadarSection,
} from "./hrRadarSection";

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

console.log(`[HR_RADAR_HONEST_GRADING_TEST] passed=${pass} failed=${fail}`);
if (fail > 0) process.exit(1);
console.log("[HR_RADAR_HONEST_GRADING_TEST] OK");
