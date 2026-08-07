// Run: npx tsx server/pregameTargets/ingestion/pr5Isolation.test.ts
// Pregame Targets PR5 — structural isolation + blindness: ingestion imports no
// other sport engine and no routes/persisted_plays/grading/analytics; no line/
// price/EV/settlement/outcome token in ingestion code; ingested feature rows carry
// no such key.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildNbaFeatureRows } from "./nbaFeatureBuilder";
import type { NbaNormalizedGameRecord } from "./nbaSourceContracts";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

const here = dirname(fileURLToPath(import.meta.url)); // server/pregameTargets/ingestion
const prodFiles = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => resolve(here, f));
prodFiles.push(resolve(here, "../../scripts/nbaPregameBackfill.ts"));

function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
}
function importLines(src: string): string {
  return src.split("\n").filter((l) => /\bfrom\s+["']/.test(l)).join("\n");
}

// ── No cross-sport engine imports ───────────────────────────────────────────
{
  const crossSport = [/server\/mlb\//, /server\/ncaab\//, /server\/nba\//, /server\/engines\/nba\//, /server\/engines\/nbaPregame\//, /\.\.\/mlb\//, /\/ncaab/];
  for (const f of prodFiles) {
    const imports = importLines(readFileSync(f, "utf8"));
    const name = f.split("/").slice(-2).join("/");
    for (const re of crossSport) ok(!re.test(imports), `${name} does not import ${re}`);
  }
}

// ── No routes / persisted_plays / grading / analytics coupling ──────────────
{
  const forbidden = [/server\/routes/, /persisted_plays/i, /recordPlay/, /settlePlay/, /gradePersistedPlays/, /server\/analytics/, /eventEmitters/, /registerAdmin|app\.(get|post)\(/];
  for (const f of prodFiles) {
    const code = codeOnly(readFileSync(f, "utf8"));
    const name = f.split("/").slice(-2).join("/");
    for (const re of forbidden) ok(!re.test(code), `${name} has no ${re} coupling`);
  }
}

// ── No line/price/EV/settlement/outcome vocabulary in ingestion CODE ─────────
{
  const forbiddenTokens = ["americanOdds", "sportsbook", "moneyline", "impliedProb", "payout", "expectedValue", "edgePct", "bookmaker", "settlement"];
  for (const f of prodFiles) {
    const code = codeOnly(readFileSync(f, "utf8"));
    const name = f.split("/").slice(-2).join("/");
    for (const tok of forbiddenTokens) ok(!code.includes(tok), `${name} computes/uses no ${tok}`);
  }
}

// ── Ingestion only touches pregame_* storage, never persisted_plays ─────────
{
  const runner = codeOnly(readFileSync(resolve(here, "../../scripts/nbaPregameBackfill.ts"), "utf8"));
  ok(!/createPlay|recordPlay|settlePlay|gradePersistedPlays|createMlb|createHr/i.test(runner), "runner touches no ledger/grading storage methods");
  ok(/createPregameRawSourceSnapshot|createPregameFeatureSnapshot|upsertPregamePosteriorState/.test(runner), "runner uses only the PR1 pregame_* storage methods");
}

// ── Runtime: ingested feature rows carry no forbidden key ───────────────────
{
  const rec: NbaNormalizedGameRecord = { gameId: "0022300500", gameDate: "2026-01-15", teamTricode: "DEN", minutes: 34, points: 30, rebounds: 8, assists: 6, threePointersMade: 3, timestamps: { sourceEffectiveAt: "", sourcePublishedAt: null, fetchedAt: "2026-08-05T18:00:00Z", knownAtPolicyVersion: "v1" } };
  const { rows } = buildNbaFeatureRows({ season: 2026, playerNativeId: "1", sourceId: "s", records: [rec] });
  const forbiddenKeys = ["line", "price", "odds", "edge", "ev", "payout", "sportsbook", "result", "outcome", "settlement", "impliedprob"];
  const dump = JSON.stringify(rows).toLowerCase();
  ok(!forbiddenKeys.some((k) => new RegExp(`"${k}"\\s*:`).test(dump)), "ingested feature rows carry no line/price/EV/outcome key");
}

console.log(`\npr5Isolation.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
