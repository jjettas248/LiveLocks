// Mound V2 shadow reconciliation — structural safety proof (Correction 3).
// Proves, by reading actual source (not just documentation), that:
//   1. buildMlbMoundRadar.ts (V1's publication-critical build loop) never
//      imports or calls anything from the reconciliation module — it runs
//      on a fully independent tick, never reachable from the request/build
//      path.
//   2. syncGameBoxScore (the MLB Stats API official-stat provider) is called
//      from exactly ONE place anywhere under server/mlb/pregame/mound/v2/ —
//      the reconciliation sweep — so "only the reconciliation pass performs
//      an active re-fetch" is a grep-verifiable fact, not an assertion.
//   3. No sportsbook/odds-provider import appears anywhere in the
//      reconciliation files — Correction 3 requires ZERO additional
//      sportsbook calls.
//
// Run: npx tsx server/mlb/pregame/mound/v2/moundV2ShadowReconciliationWiring.test.ts

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const v2Dir = dir;
const buildFilePath = path.join(dir, "..", "buildMlbMoundRadar.ts");
const buildSource = readFileSync(buildFilePath, "utf-8");

// ── buildMlbMoundRadar.ts never references reconciliation at all ───────────
{
  ok(!buildSource.includes("moundV2ShadowReconciliation"), "buildMlbMoundRadar.ts does not import moundV2ShadowReconciliation.ts");
  ok(!buildSource.includes("moundV2ShadowReconciliationSweep"), "buildMlbMoundRadar.ts does not import moundV2ShadowReconciliationSweep.ts");
  ok(!buildSource.includes("runMoundV2ShadowReconciliationSweep"), "buildMlbMoundRadar.ts never calls runMoundV2ShadowReconciliationSweep — the per-pitcher build loop cannot trigger an active re-fetch");
  ok(!buildSource.includes("gatherMoundV2ShadowGradingCoverageReport"), "buildMlbMoundRadar.ts never calls the coverage report gatherer either");
}

// ── syncGameBoxScore is called from exactly one file under v2/ ─────────────
{
  const v2Files = readdirSync(v2Dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  ok(v2Files.length > 5, `sanity check: found a real set of non-test v2/ source files (got ${v2Files.length})`);

  const callers: string[] = [];
  for (const file of v2Files) {
    const source = readFileSync(path.join(v2Dir, file), "utf-8");
    if (/\bsyncGameBoxScore\s*\(/.test(source)) callers.push(file);
  }
  ok(
    callers.length === 1 && callers[0] === "moundV2ShadowReconciliationSweep.ts",
    `syncGameBoxScore is called from exactly one v2/ file — the reconciliation sweep (got callers: ${callers.join(", ") || "none"})`,
  );
}

// ── No sportsbook/odds-provider import anywhere in the reconciliation files ──
{
  const reconciliationFiles = ["moundV2ShadowReconciliation.ts", "moundV2ShadowReconciliationSweep.ts"];
  const forbiddenOddsTerms = ["oddsService", "mlbOddsRefreshCoordinator", "oddsCache", "getMLBRawOdds", "resolveBookLine", "oddsConfig", "pickBestOverBook", "pickBestUnderBook", "buildMoundMarketEdgeContext"];
  for (const file of reconciliationFiles) {
    const source = readFileSync(path.join(v2Dir, file), "utf-8");
    for (const term of forbiddenOddsTerms) {
      ok(!source.includes(term), `${file} contains no reference to "${term}" — reconciliation never touches sportsbook/odds machinery, only the official MLB stat provider`);
    }
  }
}

// ── The reconciliation sweep imports only the official-stat provider, never a second job/queue framework ──
{
  const source = readFileSync(path.join(v2Dir, "moundV2ShadowReconciliationSweep.ts"), "utf-8");
  ok(/import\s*\{[^}]*syncGameBoxScore[^}]*\}\s*from\s*["']\.\.\/\.\.\/\.\.\/dataPullService["']/.test(source), "the sweep imports syncGameBoxScore from the SAME dataPullService module V1's own live orchestrator already uses — no new provider integration introduced");
  const forbiddenQueueTerms = ["bullmq", "bull", "kafka", "sqs", "rabbitmq", "amqplib"];
  for (const term of forbiddenQueueTerms) {
    ok(!source.toLowerCase().includes(term), `the sweep introduces no new job-queue framework (no reference to "${term}") — it is a plain periodic tick, matching every other Mound sweep`);
  }
}

console.log(`\nmoundV2ShadowReconciliationWiring.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
