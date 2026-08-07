// Run: npx tsx server/pregameTargets/ingestion/nfl/nflIsolation.test.ts
// PR6 — NFL ingestion isolation + blindness: the nfl/ ingestion modules import NO other
// sport engine (mlb/nba/ncaab) and no routes/persisted_plays/grading/analytics; no
// line/price/EV/settlement/outcome vocabulary in the code.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

const here = dirname(fileURLToPath(import.meta.url)); // server/pregameTargets/ingestion/nfl
const prodFiles = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => resolve(here, f));

const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
const importLines = (src: string) => src.split("\n").filter((l) => /\bfrom\s+["']/.test(l)).join("\n");

ok(prodFiles.length >= 6, `nfl production modules present (${prodFiles.length})`);

// ── No cross-sport engine imports ───────────────────────────────────────────
{
  const crossSport = [/server\/mlb\//, /server\/ncaab\//, /server\/nba\//, /engines\/nba\//, /engines\/nbaPregame\//, /\/nbaIngestion/, /\/nbaGameLogAdapter/, /\/nbaSourceContracts/, /\/nbaFeatureBuilder/, /\/nbaPosteriorBuilder/, /\.\.\/mlb\//, /\/ncaab/];
  for (const f of prodFiles) {
    const imports = importLines(readFileSync(f, "utf8"));
    const name = f.split("/").slice(-1)[0];
    for (const re of crossSport) ok(!re.test(imports), `${name} does not import ${re}`);
  }
}

// ── No routes / persisted_plays / grading / analytics coupling ──────────────
{
  const forbidden = [/server\/routes/, /persisted_plays/i, /recordPlay/, /settlePlay/, /gradePersistedPlays/, /server\/analytics/, /registerAdmin|app\.(get|post)\(/];
  for (const f of prodFiles) {
    const code = codeOnly(readFileSync(f, "utf8"));
    const name = f.split("/").slice(-1)[0];
    for (const re of forbidden) ok(!re.test(code), `${name} has no ${re} coupling`);
  }
}

// ── No line/price/EV/settlement/outcome vocabulary in ingestion CODE ─────────
{
  const forbiddenTokens = ["americanOdds", "sportsbook", "moneyline", "impliedProb", "payout", "expectedValue", "edgePct", "bookmaker", "settlement"];
  for (const f of prodFiles) {
    const code = codeOnly(readFileSync(f, "utf8"));
    const name = f.split("/").slice(-1)[0];
    for (const tok of forbiddenTokens) ok(!code.includes(tok), `${name} uses no ${tok}`);
  }
}

console.log(`\nnflIsolation.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
