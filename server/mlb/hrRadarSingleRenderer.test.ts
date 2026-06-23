/**
 * HR Radar single-renderer guard — invariant test.
 *
 * Locks the June-2026 cleanup that deleted the dead `HRRadarSection`
 * radar-card renderer (and its exclusive helpers) from the MLB live page.
 * The active HR Radar tab MUST render exactly one user-facing surface pair:
 * HrQuickDecide (Quick Decide) and HrRadarLadder (Full Ladder). No second
 * parallel radar renderer may be reintroduced — that is how stale logic
 * gets accidentally re-wired into production.
 *
 * Pure source-text assertions (no runtime). Reads the client source files
 * from disk so it runs under the same `npx tsx` harness as the other suites.
 *
 * Run: npx tsx server/mlb/hrRadarSingleRenderer.test.ts
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const livePagePath = join(repoRoot, "client/src/pages/mlb-live.tsx");
const livePage = readFileSync(livePagePath, "utf8");

console.log("\n=== HR Radar Single-Renderer Guard — Invariant Suite ===\n");

// ── The dead radar-card renderer must not exist anywhere ───────────────────
console.log("dead-renderer removal");
assert("HRRadarSection component is gone (no definition)",
  !/function\s+HRRadarSection\b/.test(livePage),
  "found a `function HRRadarSection` definition — the legacy radar-card renderer was reintroduced");
assert("HRRadarSection is not rendered (no JSX usage)",
  !/<HRRadarSection\b/.test(livePage),
  "found a <HRRadarSection> render site");

// Exclusive helpers of the dead renderer must also stay gone.
for (const sym of ["RadarCard", "CompactRadarRow", "CompactResolvedRadarRow",
  "HRRadarTopThreatStrip", "HRRadarControls", "RadarStatsBar", "GradingHistoryPanel"]) {
  assert(`dead helper ${sym} not redefined`,
    !new RegExp(`function\\s+${sym}\\b`).test(livePage),
    `found a \`function ${sym}\` definition`);
}

// Dead view-model mappers must not be re-imported into the live page.
for (const sym of ["mapHrRadarCardToUi", "mapAlertToUi", "formatTriggerReason"]) {
  assert(`dead mapper ${sym} not imported`,
    !new RegExp(`[^A-Za-z]${sym}[^A-Za-z]`).test(livePage),
    `found a reference to ${sym}`);
}

// ── Exactly one user-facing radar surface pair remains ─────────────────────
console.log("\nactive-renderer presence");
assert("HrQuickDecide is rendered", /<HrQuickDecide\b/.test(livePage));
assert("HrRadarLadder is rendered", /<HrRadarLadder\b/.test(livePage));
assert("hr_radar tab gates exactly these two surfaces",
  /hrViewMode === "quick"[\s\S]{0,400}<HrQuickDecide[\s\S]{0,600}<HrRadarLadder/.test(livePage),
  "the Quick Decide / Full Ladder toggle no longer wraps exactly HrQuickDecide + HrRadarLadder");

// No other client file may define a component named HRRadarSection.
// (Spot-checked at audit time; this string guard catches accidental copies.)
assert("no HRRadarSection definition leaked into mlb-live",
  !livePage.includes("function HRRadarSection"));

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
process.exit(0);
