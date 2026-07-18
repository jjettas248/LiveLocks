// Pre-Game Power Radar — internal Total Bases outcome classification invariants.
//
// Guards isolation from the HR-oriented winAttribution.ts: this classifier
// must never be able to influence `outcome`/`userVisible`, and must never
// fabricate a result when the final line is unavailable.
//
// Run: npx tsx server/mlb/pregamePowerRadar/totalBasesOutcome.test.ts

import { classifyTotalBasesOutcome } from "./totalBasesOutcome";
import { deriveWinAttribution } from "./winAttribution";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

ok(classifyTotalBasesOutcome(2) === "tb_success", "2 total bases → tb_success");
ok(classifyTotalBasesOutcome(4) === "tb_success", "4 total bases → tb_success");
ok(classifyTotalBasesOutcome(1) === "tb_miss", "1 total base → tb_miss");
ok(classifyTotalBasesOutcome(0) === "tb_miss", "0 total bases → tb_miss");
ok(classifyTotalBasesOutcome(null) === "tb_unknown", "null (unresolved) → tb_unknown, never fabricated");
ok(classifyTotalBasesOutcome(undefined) === "tb_unknown", "undefined → tb_unknown");

// ── Isolation: deriveWinAttribution's existing HR-only behavior is byte-for-byte unchanged ──
{
  const hit = deriveWinAttribution({ hitHr: true, wasPubliclyFlagged: true, priorABResults: [{ hitType: "home_run", inning: 3, half: "top" }] });
  ok(hit.outcome === "pregame_win" && hit.userVisible === true, "HR win attribution unaffected by the existence of the TB classifier");
  ok(!("tbOutcome" in hit), "WinAttributionResult has no tbOutcome field — isolation is structural, not just behavioral");

  const miss = deriveWinAttribution({ hitHr: false, wasPubliclyFlagged: true });
  ok(miss.outcome === "calibration_miss" && miss.userVisible === false, "HR calibration_miss unaffected");
}

console.log(`\ntotalBasesOutcome.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
