// Mound Radar PR 2/5 — engine-parity / isolation guarantee.
// Static, source-scan proof (mirrors contactRisk.test.ts's isolation-guarantee
// pattern) that production scoring/direction/market-tagging files never
// reference the new rawContactSnapshot field or type — it can only ever
// reach a MoundEvaluationSnapshot's champion object, never score10, tier,
// direction, ranking, qualification, or market selection.
//
// MANUAL STEP (not automatable in this plain-tsx harness without a two-
// checkout diff): run moundScoring.test.ts / moundDirection.test.ts /
// moundOutcomeAttribution.test.ts / moundCalibrationStats.test.ts on the
// parent commit and on this branch against an identical fixed fixture set
// and confirm score10/tier/direction/rank/market scores/primaryMarket/
// evidence drivers/contactRiskScore/Plate outputs are byte-identical — the
// only permitted difference is the new evaluation-only measurement snapshot.
// Run: npx tsx server/mlb/pregame/mound/rawContactSnapshotParity.test.ts

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const FORBIDDEN_PATTERN = /rawContactSnapshot|RawPitcherContactSnapshot|aggregateRawPitcherContactSnapshot/;

const isolatedFiles = ["scoring.ts", "moundDirection.ts", "marketTagger.ts", "contactRisk.ts", "diagnostics.ts"];
for (const file of isolatedFiles) {
  const src = readFileSync(join(HERE, file), "utf8");
  if (file === "diagnostics.ts") {
    // diagnostics.ts DOES legitimately reference rawContactSnapshot — to
    // STRIP it for non-admin responses (withoutResearchInstrumentation). The
    // isolation guarantee here is narrower: extract ONLY the
    // isPublicMoundSignal/wasPubliclyFlaggedMound function bodies (the
    // qualification/ranking predicates) and confirm the forbidden pattern
    // never appears inside THEM specifically — not a whole-file substring
    // scan, which would false-positive on the function NAME appearing
    // earlier in the file than an unrelated later reference.
    for (const fn of ["isPublicMoundSignal", "wasPubliclyFlaggedMound", "wasPubliclyFlaggedMoundFade"]) {
      const start = src.indexOf(`export function ${fn}(`);
      ok(start !== -1, `sanity: ${fn} found in diagnostics.ts`);
      const afterStart = src.slice(start);
      const nextExportIdx = afterStart.indexOf("\nexport ", 1);
      const body = nextExportIdx === -1 ? afterStart : afterStart.slice(0, nextExportIdx);
      ok(!FORBIDDEN_PATTERN.test(body), `diagnostics.ts: ${fn}'s function body never references rawContactSnapshot (qualification/ranking stays untouched)`);
    }
    continue;
  }
  ok(!FORBIDDEN_PATTERN.test(src), `${file}: never references rawContactSnapshot/RawPitcherContactSnapshot/aggregateRawPitcherContactSnapshot in any form`);
}

// The aggregator itself and the evaluation-snapshot wiring are the ONLY
// legitimate reference points — sanity-check they DO reference it, so this
// test isn't just trivially vacuous.
const evalSrc = readFileSync(join(HERE, "evaluationSnapshot.ts"), "utf8");
ok(FORBIDDEN_PATTERN.test(evalSrc), "sanity: evaluationSnapshot.ts DOES legitimately reference the new snapshot (confirms the isolation check above is meaningful, not vacuous)");

console.log(`\nrawContactSnapshotParity.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
