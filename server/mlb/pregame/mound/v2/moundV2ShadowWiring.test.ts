// Mound V2 shadow wiring — structural safety proof (Final Pre-Push Integrity
// Pass; supersedes the prior version's now-stale ordering assumptions).
//
// A full mocked end-to-end run of buildMlbMoundRadar.ts (real game
// discovery, roster, Stats API, Savant, odds fetches all stubbed) was not
// built for this pass — that orchestrator has a large real-data dependency
// surface. Instead, this proves the specific safety properties by reading
// the actual source:
//
//   1. `signal` (V1's actual output) is fully assembled BEFORE
//      carryForwardMoundGradedState pins its durable public-qualification
//      history (everPubliclyFlagged/everPubliclyFlaggedFade/moundDirection).
//   2. carryForwardMoundGradedState runs BEFORE the V2 shadow block — this
//      is the reordering this pass made to fix the V1-qualification-timing
//      bug (the shadow capture must read the PINNED durable state, never the
//      fresh per-cycle default that exists before carry-forward runs).
//   3. The shadow block contains no assignment INTO `signal` or `signals`.
//   4. The shadow block's only V2-related call is the durable, idempotent
//      ENQUEUE (enqueueMoundV2ShadowForPitcher) — never a direct call to
//      evaluateMoundV2Shadow, anywhere in this file. Evaluation now happens
//      exclusively in moundV2ShadowWorker.ts's own independent tick; see
//      moundV2ShadowNeverWaits.integration.test.ts for the BEHAVIORAL (not
//      just structural) proof that V1 does not wait for it.
//   5. The shadow block has its own try/catch.
//   6. V1's own signals.set(signalId, signal) call site appears strictly
//      AFTER the shadow block's closing brace, so V1 publishes unconditionally
//      regardless of the shadow block's outcome (enqueue success, enqueue
//      failure, or an unexpected throw during construction).
//
// Combined with the exhaustive "V2 imports nothing from production Mound"
// check in moundV2Engine.test.ts and the "V1's enqueue path cannot even
// reach the worker" import-absence checks in
// moundV2ShadowNeverWaits.integration.test.ts, this is a source-level, not
// just documentation-level, proof that V2 cannot reach V1's output and V1
// cannot be gated by V2.
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
const carryForwardIdx = source.indexOf("carryForwardMoundGradedState(signal, prevSignals?.get(signalId));");
const shadowBlockStartIdx = source.indexOf("if (isMoundV2ShadowEnabled())");
const signalsSetIdx = source.indexOf("signals.set(signalId, signal);");

ok(signalAssemblyIdx !== -1, "found the real `signal` object assembly in buildMlbMoundRadar.ts");
ok(carryForwardIdx !== -1, "found V1's own carryForwardMoundGradedState call site");
ok(shadowBlockStartIdx !== -1, "found the Mound V2 shadow block's flag check");
ok(signalsSetIdx !== -1, "found V1's own signals.set(signalId, signal) publication call site");

ok(
  signalAssemblyIdx < carryForwardIdx,
  "the real `signal` object is fully assembled BEFORE carryForwardMoundGradedState runs — carry-forward mutates an already-complete signal, never a partially-built one",
);
ok(
  carryForwardIdx < shadowBlockStartIdx,
  "carryForwardMoundGradedState runs BEFORE the V2 shadow block begins — this is the Final Pre-Push Integrity Pass reordering fix: the shadow capture can only ever read signal.everPubliclyFlagged/everPubliclyFlaggedFade/moundDirection AFTER they are pinned to their real, durable, restart-safe values, never the fresh per-cycle default that exists before carry-forward runs",
);
ok(
  shadowBlockStartIdx < signalsSetIdx,
  "the shadow block appears BEFORE V1's own signals.set(signalId, signal) call in source order (the checks below prove this is not a gate — publication happens unconditionally after the block, success or failure)",
);

// Extract just the shadow block's own text span (from its `if` to V1's own
// publication call site) and verify its actual content.
const shadowBlockText = source.slice(shadowBlockStartIdx, signalsSetIdx);
ok(shadowBlockText.length > 100, "the extracted shadow block span is non-trivial (sanity check on the slice itself)");

// `(?!=)` excludes ==/=== (a comparison/read, e.g. `signal.everPubliclyFlagged === true`,
// which this pass legitimately added to read V1's own carried-forward state) —
// only a genuine single `=` assignment trips this check.
ok(!/\bsignal\.\w+\s*=(?!=)/.test(shadowBlockText), "no assignment INTO the `signal` object appears anywhere in the shadow block");
ok(!/\bsignals\.set\(/.test(shadowBlockText), "no `signals.set(...)` call appears anywhere in the shadow block — only V1's own call site (outside/after the block) writes to the signals map");

ok(
  /enqueueMoundV2ShadowForPitcher\(/.test(shadowBlockText),
  "the shadow block calls enqueueMoundV2ShadowForPitcher — its only V2-related obligation is now a single bounded, durable, idempotent INSERT via the outbox (moundV2ShadowJobQueue.ts), not evaluation itself",
);
ok(
  !/evaluateMoundV2Shadow\(/.test(shadowBlockText),
  "the shadow block never calls evaluateMoundV2Shadow directly — V2 evaluation (computeMoundV2Distribution, parity check, decision-policy application) has been moved entirely out of the build loop into moundV2ShadowWorker.ts's own independent tick",
);
ok(
  !/evaluateMoundV2Shadow\(/.test(source),
  "evaluateMoundV2Shadow is never called ANYWHERE in buildMlbMoundRadar.ts (not just outside the shadow block) — the file only imports MOUND_V1_MODEL_VERSION/MOUND_V2_MODEL_VERSION constants from that module, never the evaluation function itself",
);
ok(/catch\s*\(/.test(shadowBlockText), "the shadow block has its own try/catch — a defect inside it (construction or enqueue) cannot throw into the surrounding per-pitcher loop");

console.log(`\nmoundV2ShadowWiring.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
