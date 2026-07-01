// HR Radar display grade — unit tests for the server-computed letter grade.
// Run: npx tsx server/mlb/hrRadarDisplayGrade.test.ts

import { deriveHrRadarDisplayGrade } from "../../shared/hrRadarStage";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.error(`[HR_RADAR_GRADE_TEST] FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

// ─── Resolved rows carry no grade ───────────────────────────────────────
check("resolved → null regardless of score", deriveHrRadarDisplayGrade("resolved", 9.9) === null);
check("resolved → null with null score", deriveHrRadarDisplayGrade("resolved", null) === null);

// ─── Fire — top of the ladder ───────────────────────────────────────────
check("fire @9.5 → A+", deriveHrRadarDisplayGrade("fire", 9.5) === "A+");
check("fire @10.0 → A+", deriveHrRadarDisplayGrade("fire", 10.0) === "A+");
check("fire @9.4 → A", deriveHrRadarDisplayGrade("fire", 9.4) === "A");
check("fire @9.0 (fallback floor) → A", deriveHrRadarDisplayGrade("fire", 9.0) === "A");
check("fire @null (missing score) → A (never worse than A at fire)", deriveHrRadarDisplayGrade("fire", null) === "A");

// ─── Ready — high-conviction, not yet official ──────────────────────────
check("ready @9.0 → A", deriveHrRadarDisplayGrade("ready", 9.0) === "A");
check("ready @8.9 → B+", deriveHrRadarDisplayGrade("ready", 8.9) === "B+");
check("ready @8.0 (boundary) → B+", deriveHrRadarDisplayGrade("ready", 8.0) === "B+");
check("ready @7.9 → B", deriveHrRadarDisplayGrade("ready", 7.9) === "B");
check("ready @7.5 (fallback floor) → B", deriveHrRadarDisplayGrade("ready", 7.5) === "B");
check("ready @null → B (never below B at ready)", deriveHrRadarDisplayGrade("ready", null) === "B");

// ─── Build — forming, not yet playable ──────────────────────────────────
check("build @6.5 (boundary) → B-", deriveHrRadarDisplayGrade("build", 6.5) === "B-");
check("build @6.4 → Watch", deriveHrRadarDisplayGrade("build", 6.4) === "Watch");
check("build @5.5 (fallback floor) → Watch", deriveHrRadarDisplayGrade("build", 5.5) === "Watch");
check("build @null → Watch", deriveHrRadarDisplayGrade("build", null) === "Watch");

// ─── Track — earliest formation, always Watch ───────────────────────────
check("track @2.5 (fallback floor) → Watch", deriveHrRadarDisplayGrade("track", 2.5) === "Watch");
check("track @9.9 (still Watch — stage caps grade, not just score) → Watch", deriveHrRadarDisplayGrade("track", 9.9) === "Watch");
check("track @null → Watch", deriveHrRadarDisplayGrade("track", null) === "Watch");

// ─── Monotonicity: higher score within a stage never grades worse ──────
const STAGES = ["track", "build", "ready", "fire"] as const;
const GRADE_RANK: Record<string, number> = { Watch: 0, "B-": 1, B: 2, "B+": 3, A: 4, "A+": 5 };
for (const stage of STAGES) {
  const lo = deriveHrRadarDisplayGrade(stage, 3.0);
  const hi = deriveHrRadarDisplayGrade(stage, 9.9);
  check(
    `monotonic — ${stage}: score 9.9 grades >= score 3.0`,
    GRADE_RANK[hi ?? "Watch"] >= GRADE_RANK[lo ?? "Watch"],
    `lo=${lo} hi=${hi}`,
  );
}

// ─── Cross-stage ordering at the calibrated fallback floors ─────────────
// A row's stage should never grade worse than a lower stage at its own floor.
const floorGrades = {
  track: deriveHrRadarDisplayGrade("track", 2.5)!,
  build: deriveHrRadarDisplayGrade("build", 5.5)!,
  ready: deriveHrRadarDisplayGrade("ready", 7.5)!,
  fire: deriveHrRadarDisplayGrade("fire", 9.0)!,
};
check(
  "stage ordering at fallback floors: track <= build <= ready <= fire",
  GRADE_RANK[floorGrades.track] <= GRADE_RANK[floorGrades.build] &&
    GRADE_RANK[floorGrades.build] <= GRADE_RANK[floorGrades.ready] &&
    GRADE_RANK[floorGrades.ready] <= GRADE_RANK[floorGrades.fire],
  JSON.stringify(floorGrades),
);

console.log(`[HR_RADAR_GRADE_TEST] passed=${pass} failed=${fail}`);
if (fail > 0) process.exit(1);
console.log("[HR_RADAR_GRADE_TEST] OK");
