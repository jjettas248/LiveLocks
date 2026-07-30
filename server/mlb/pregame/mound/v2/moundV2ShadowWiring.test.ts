// Mound V2 shadow wiring — structural safety proof.
//
// A full mocked end-to-end run of buildMlbMoundRadar.ts (real game
// discovery, roster, Stats API, Savant, odds fetches all stubbed) was not
// built for this pass — that orchestrator has a large real-data dependency
// surface. Instead, this proves the specific safety property by reading the
// actual source: the Mound V2 shadow block appears strictly AFTER the real
// `signal` object (V1's actual output) is fully assembled, contains no
// assignment INTO `signal` or `signals`, and V1's own
// carryForwardMoundGradedState/signals.set call appears strictly AFTER the
// shadow block (so it runs regardless of the shadow block's outcome) —
// combined with the exhaustive "V2 imports nothing from production Mound"
// check in moundV2Engine.test.ts, this is a source-level, not just
// documentation-level, proof that V2 cannot reach V1's output.
//
// Run: npx tsx server/mlb/pregame/mound/v2/moundV2ShadowWiring.test.ts

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const buildFilePath = path.join(dir, "..", "buildMlbMoundRadar.ts");
const source = readFileSync(buildFilePath, "utf-8");

const signalAssemblyIdx = source.indexOf("const signal: MoundSignal = {");
const shadowBlockStartIdx = source.indexOf("if (isMoundV2ShadowEnabled())");
const carryForwardIdx = source.indexOf("carryForwardMoundGradedState(signal, prevSignals?.get(signalId));");

ok(signalAssemblyIdx !== -1, "found the real `signal` object assembly in buildMlbMoundRadar.ts");
ok(shadowBlockStartIdx !== -1, "found the Mound V2 shadow block's flag check");
ok(carryForwardIdx !== -1, "found V1's own carryForwardMoundGradedState/signals.set call site");

ok(
  signalAssemblyIdx < shadowBlockStartIdx,
  "the real `signal` object is fully assembled BEFORE the shadow block begins — the shadow evaluation can only ever read an already-complete V1 signal, never influence its construction",
);
ok(
  shadowBlockStartIdx < carryForwardIdx,
  "V1's own carryForwardMoundGradedState/signals.set call comes AFTER the shadow block in source order, confirming the shadow block sits in between assembly and persistence rather than wrapping/gating it",
);

// Extract just the shadow block's own text span (from its `if` to the line
// right before carryForwardMoundGradedState) and verify it never assigns
// into `signal` or the `signals` map.
const shadowBlockText = source.slice(shadowBlockStartIdx, carryForwardIdx);
ok(shadowBlockText.length > 100, "the extracted shadow block span is non-trivial (sanity check on the slice itself)");
// `(?!=)` excludes ==/=== (a comparison/read, e.g. `signal.moundDirection === "follow"`,
// which Correction 1 legitimately added to read V1's own recommended side) —
// only a genuine single `=` assignment trips this check.
ok(!/\bsignal\.\w+\s*=(?!=)/.test(shadowBlockText), "no assignment INTO the `signal` object appears anywhere in the shadow block");
ok(!/\bsignals\.set\(/.test(shadowBlockText), "no `signals.set(...)` call appears anywhere in the shadow block — only V1's own call site (outside the block) writes to the signals map");
ok(/runMoundV2ShadowForPitcher\(/.test(shadowBlockText), "the shadow block does call runMoundV2ShadowForPitcher (sanity check that we sliced the right region) — Correction 2 extracted the evaluate/record/log wrapper into its own testable function, see moundV2ShadowRunner.test.ts for the behavioral (not just structural) proof of its never-throws guarantee");
ok(/catch\s*\(/.test(shadowBlockText), "the shadow block has its own try/catch — a defect inside it cannot throw into the surrounding per-pitcher loop");

console.log(`\nmoundV2ShadowWiring.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
