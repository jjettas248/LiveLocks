/**
 * HR Radar canonical badge derivation — invariant test (Step 5).
 *
 * Locks the single badge taxonomy in shared/hrRadarStage.ts: badges are
 * derived from evidence, are additive (absent inputs ⇒ no badge), resolved
 * rows carry none, and "HR Max Window" is a badge on the Fire/Ready stages —
 * never a stage itself.
 *
 * Run: npx tsx server/mlb/hrRadarBadges.test.ts
 */

import {
  deriveHrRadarBadges,
  isHrMaxWindowStage,
  HR_RADAR_BADGE_META,
  HR_RADAR_STAGE_RANK,
  type HrRadarBadge,
} from "../../shared/hrRadarStage";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function sameSet(name: string, actual: HrRadarBadge[], expected: HrRadarBadge[]): void {
  const a = [...actual].sort().join(",");
  const e = [...expected].sort().join(",");
  assert(name, a === e, `expected=[${e}] actual=[${a}]`);
}

console.log("\n=== HR Radar Canonical Badge Derivation — Invariant Suite ===\n");

console.log("hr_max_window = Fire/Ready only");
assert("fire is HR Max Window", isHrMaxWindowStage("fire"));
assert("ready is HR Max Window", isHrMaxWindowStage("ready"));
assert("build is not", !isHrMaxWindowStage("build"));
assert("track is not", !isHrMaxWindowStage("track"));
sameSet("fire stage yields hr_max_window", deriveHrRadarBadges({ stage: "fire" }), ["hr_max_window"]);
sameSet("ready stage yields hr_max_window", deriveHrRadarBadges({ stage: "ready" }), ["hr_max_window"]);
sameSet("build stage yields no hr_max_window", deriveHrRadarBadges({ stage: "build" }), []);

console.log("\nevidence → badge mapping");
sameSet("near_barrel → near_hr_contact (build)",
  deriveHrRadarBadges({ stage: "build", qualifyingSignals: ["near_barrel"] }), ["near_hr_contact"]);
sameSet("high_xba_danger → near_hr_contact",
  deriveHrRadarBadges({ stage: "build", qualifyingSignals: ["high_xba_danger"] }), ["near_hr_contact"]);
sameSet("pitcher_collapse_power → pitcher_fatigue",
  deriveHrRadarBadges({ stage: "build", qualifyingSignals: ["pitcher_collapse_power"] }), ["pitcher_fatigue"]);
sameSet("elite_barrel → barrel_trend",
  deriveHrRadarBadges({ stage: "build", qualifyingSignals: ["elite_barrel"] }), ["barrel_trend"]);
sameSet("PATH_F_BLOCKED_BRIDGE → bridge_path",
  deriveHrRadarBadges({ stage: "track", alertPath: "PATH_F_BLOCKED_BRIDGE" }), ["bridge_path"]);
sameSet("parkBoost → park_boost",
  deriveHrRadarBadges({ stage: "build", parkBoost: true }), ["park_boost"]);
sameSet("non-bridge path → no bridge_path",
  deriveHrRadarBadges({ stage: "build", alertPath: "PATH_A" }), []);

console.log("\ncomposition + additivity");
sameSet("fire + elite_barrel + fatigue + bridge + park",
  deriveHrRadarBadges({
    stage: "fire",
    qualifyingSignals: ["elite_barrel", "pitcher_collapse_power"],
    alertPath: "PATH_F_BLOCKED_BRIDGE",
    parkBoost: true,
  }),
  ["hr_max_window", "barrel_trend", "pitcher_fatigue", "bridge_path", "park_boost"]);
sameSet("no evidence on track → empty", deriveHrRadarBadges({ stage: "track" }), []);
sameSet("resolved carries no badges even with evidence",
  deriveHrRadarBadges({ stage: "resolved", qualifyingSignals: ["elite_barrel"], alertPath: "PATH_F_BLOCKED_BRIDGE", parkBoost: true }), []);
assert("case-insensitive signal match",
  deriveHrRadarBadges({ stage: "build", qualifyingSignals: ["ELITE_BARREL"] }).includes("barrel_trend"));

console.log("\nmetadata + rank integrity");
const allBadges: HrRadarBadge[] = ["hr_max_window", "near_hr_contact", "pitcher_fatigue", "park_boost", "barrel_trend", "bridge_path"];
assert("every badge has meta with label+tone+title",
  allBadges.every(b => HR_RADAR_BADGE_META[b]?.label && HR_RADAR_BADGE_META[b]?.tone && HR_RADAR_BADGE_META[b]?.title));
assert("stage rank orders track<build<ready<fire",
  HR_RADAR_STAGE_RANK.track < HR_RADAR_STAGE_RANK.build &&
  HR_RADAR_STAGE_RANK.build < HR_RADAR_STAGE_RANK.ready &&
  HR_RADAR_STAGE_RANK.ready < HR_RADAR_STAGE_RANK.fire);

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
process.exit(0);
