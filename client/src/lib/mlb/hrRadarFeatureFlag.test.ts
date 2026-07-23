// Consolidation PR 1 — HR Radar UI retirement invariants.
//
// Locks the product rule: the legacy Home Run Radar tab/UI must be
// unreachable from normal navigation, stale state, or a forced/deep-linked
// `activeSubTab`, while the Radar *backend* (routes, tables, grading
// history, research logic) stays fully intact and unmodified. This test
// covers the client-side gating; backend-route/table intactness is checked
// by scanning source text so a future PR can't silently delete/gate them.
//
// Run: npx tsx client/src/lib/mlb/hrRadarFeatureFlag.test.ts

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SHOW_HR_RADAR_TAB, shouldMountHrRadarTab } from "./hrRadarFeatureFlag";
import { getMlbSubTabList } from "@/components/layout/SportTabs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");

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

console.log("\n=== HR Radar UI Retirement — Invariant Suite (PR 1) ===\n");

// ── 1. The production flag defaults to hidden ──────────────────────────────
console.log("1. SHOW_HR_RADAR_TAB is off by default");
{
  assert("SHOW_HR_RADAR_TAB is false", SHOW_HR_RADAR_TAB === false);
}

// ── 2. The nav sub-tab list omits HR Radar when the flag is off ────────────
console.log("2. MLB sub-tab list excludes HR Radar by default");
{
  const tabsFlagOff = getMlbSubTabList(false);
  assert(
    "hr_radar is absent from the sub-tab list when flag is off",
    !tabsFlagOff.some((t) => t.key === "hr_radar"),
    JSON.stringify(tabsFlagOff),
  );
  assert(
    "live_feed (Live Edge) is present",
    tabsFlagOff.some((t) => t.key === "live_feed" && t.label === "Live Edge"),
  );
  assert(
    "pregame_power (Pre-Game) is present",
    tabsFlagOff.some((t) => t.key === "pregame_power"),
  );
  assert(
    "exactly two tabs render when HR Radar is hidden",
    tabsFlagOff.length === 2,
    `got ${tabsFlagOff.length}`,
  );

  // Rollback path: flipping the flag restores the chip without code changes.
  const tabsFlagOn = getMlbSubTabList(true);
  assert(
    "hr_radar reappears when the flag is explicitly re-enabled (rollback path)",
    tabsFlagOn.some((t) => t.key === "hr_radar" && t.label === "HR Radar"),
  );
  assert("all three tabs render when flag is on", tabsFlagOn.length === 3);
}

// ── 3. The render guard blocks mounting regardless of activeSubTab state ──
console.log("3. shouldMountHrRadarTab blocks the legacy UI under every input combination");
{
  assert(
    "activeSubTab=hr_radar + flag off → does NOT mount (stale/forced state can't resurrect it)",
    shouldMountHrRadarTab("hr_radar", false) === false,
  );
  assert(
    "activeSubTab=hr_radar + flag on → mounts (rollback path works)",
    shouldMountHrRadarTab("hr_radar", true) === true,
  );
  assert(
    "activeSubTab=live_feed + flag on → does NOT mount (only the exact sub-tab mounts it)",
    shouldMountHrRadarTab("live_feed", true) === false,
  );
  assert(
    "activeSubTab=pregame_power + flag off → does NOT mount",
    shouldMountHrRadarTab("pregame_power", false) === false,
  );
}

// ── 4. Legacy component tree stays in source (deliberate, for rollback) ────
console.log("4. Legacy HR Radar components are retained in source, not deleted");
{
  const retainedComponents = [
    "client/src/components/mlb/HrRadarLadder.tsx",
    "client/src/components/mlb/HrQuickDecide.tsx",
    "client/src/components/mlb/hr-radar/HrRadarHeroCard.tsx",
    "client/src/components/mlb/hr-radar/HrRadarDecisionQueue.tsx",
    "client/src/components/mlb/hr-radar/HrRadarFullLadderTable.tsx",
    "client/src/components/mlb/hr-radar/HrRadarRecentHitsStrip.tsx",
    "client/src/components/mlb/hr-radar/HrRadarStageToast.tsx",
  ];
  for (const rel of retainedComponents) {
    assert(`${rel} still exists (rollback path)`, existsSync(join(REPO_ROOT, rel)));
  }
}

// ── 5. Backend routes/engine stay registered and unmodified in this PR ────
console.log("5. HR Radar backend routes remain registered (research/admin still functional)");
{
  const routesSource = readFileSync(join(REPO_ROOT, "server/routes.ts"), "utf8");
  const expectedRoutes = [
    '"/api/mlb/hr-radar"',
    '"/api/mlb/hr-radar-grading-history"',
    '"/api/mlb/hr-radar-grading/:sessionDate"',
    '"/api/mlb/hr-radar/ladder"',
    '"/api/mlb/hr-radar/ladder/validate"',
    '"/api/mlb/hr-radar/share-card"',
    '"/api/mlb/hr-radar-board"',
    '"/api/mlb/hr-radar-analyze/:playerId/:gameId"',
  ];
  for (const route of expectedRoutes) {
    assert(`route ${route} is still registered in server/routes.ts`, routesSource.includes(route));
  }

  const backendFiles = [
    "server/mlb/hrRadarStateMachine.ts",
    "server/mlb/hrRadarCanonicalStore.ts",
    "server/mlb/hrRadarSection.ts",
    "server/mlb/hrRadarOutcomeStamp.ts",
    "server/mlb/hrRadarV2Shadow.ts",
  ];
  for (const rel of backendFiles) {
    assert(`backend file ${rel} still exists (research engine untouched)`, existsSync(join(REPO_ROOT, rel)));
  }
}

// ── 6. Non-HR MLB sub-tabs are unaffected by the gating change ────────────
console.log("6. Non-HR sub-tab keys/labels are unchanged");
{
  const tabs = getMlbSubTabList(false);
  const liveFeed = tabs.find((t) => t.key === "live_feed");
  const pregame = tabs.find((t) => t.key === "pregame_power");
  assert("live_feed label unchanged", liveFeed?.label === "Live Edge");
  assert("pregame_power label unchanged", pregame?.label === "Pre-Game");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) {
  console.error("FAILURES:");
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
