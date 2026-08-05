// Run: npx tsx server/engines/nbaPregame/decision/pr4Isolation.test.ts
// Pregame Targets PR4 — structural isolation: the decision + calibration layers
// import nothing from another sport engine and nothing from routes/persistence/
// client/UI; PR3 stays structurally blind; the decision result carries a line but
// no odds/EV/price key.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { evaluateFreshLine } from "./freshLineDecision";
import { computeNbaProjection, type NbaProjectionEngineInput } from "../nbaProjectionEngine";
import { carriesForbiddenKey } from "../frozenNbaProjectionInput";
import { emptyPosteriorState, updatePosterior, type PosteriorState, type Prior } from "../../../pregameTargets/posteriorState/posteriorState";
import { allocateTeamMinutes, playerMinutes } from "../minutes/teamMinutesAllocator";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const here = dirname(fileURLToPath(import.meta.url)); // server/engines/nbaPregame/decision
const nbaPregame = resolve(here, "..");

const PR4_SOURCES = [
  resolve(nbaPregame, "decision/lineProbabilities.ts"),
  resolve(nbaPregame, "decision/freshLineDecision.ts"),
  resolve(nbaPregame, "calibration/walkForwardCalibration.ts"),
];

// ── No cross-sport engine imports anywhere in PR4 sources ────────────────────
{
  const crossSport = [/server\/mlb\//, /server\/nba\//, /server\/ncaab\//, /\.\.\/\.\.\/mlb\//, /\.\.\/\.\.\/nba\//, /\.\.\/\.\.\/ncaab\//, /engines\/nba\//];
  for (const file of PR4_SOURCES) {
    const src = readFileSync(file, "utf8");
    const importLines = src.split("\n").filter((l) => /^\s*import\b/.test(l) || /\bfrom\s+["']/.test(l));
    const joined = importLines.join("\n");
    for (const re of crossSport) {
      ok(!re.test(joined), `${file.split("/").slice(-2).join("/")} does not import ${re}`);
    }
  }
}

// ── No route / persistence / client / UI imports in PR4 sources ──────────────
{
  const forbidden = [/server\/routes/, /server\/storage/, /server\/db/, /client\//, /\/routes["']/, /storage["']/, /schedulers?/];
  for (const file of PR4_SOURCES) {
    const src = readFileSync(file, "utf8");
    const importLines = src.split("\n").filter((l) => /\bfrom\s+["']/.test(l));
    const joined = importLines.join("\n");
    for (const re of forbidden) {
      ok(!re.test(joined), `${file.split("/").slice(-2).join("/")} does not import ${re}`);
    }
  }
}

// ── PR4 sources reference no line/odds/EV token in their PUBLIC allowed set ──
//    (the decision layer legitimately handles a `line`, so we only assert the
//     forbidden PRICING vocabulary — odds/price/edge/EV/payout/sportsbook-select —
//     is not computed; `sportsbook` appears only as a provenance label.)
{
  // Strip comments first — the header prose legitimately NAMES the forbidden
  // vocabulary while promising not to compute it; we assert against CODE only.
  const raw = readFileSync(resolve(nbaPregame, "decision/freshLineDecision.ts"), "utf8");
  const codeOnly = raw
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, "")) // line comments
    .join("\n");
  for (const tok of ["americanOdds", "expectedValue", "computeEv", "payout", "impliedProb", "stake", "edgePct"]) {
    ok(!codeOnly.includes(tok), `freshLineDecision.ts code computes no ${tok}`);
  }
}

// ── Runtime: PR3 projection stays blind; decision carries line, not odds/EV ──
{
  const SEASON = 2026;
  const g = (id: string) => `nba:game:${id}`;
  const rp = (key: string, n: number, rate: number): PosteriorState => {
    let st = emptyPosteriorState(`nba.player.${key}_per_min`, "v1", "nba:player:1");
    for (let i = 0; i < n; i++) st = updatePosterior(st, { value: rate, weight: 1, season: SEASON, gameId: g(`${key}${i}`) });
    return st;
  };
  const priors = { points: { mean: 0.5, strength: 3 }, rebounds: { mean: 0.22, strength: 3 }, assists: { mean: 0.15, strength: 3 }, three_pointers_made: { mean: 0.06, strength: 3 } } as Record<never, Prior>;
  const alloc = allocateTeamMinutes({ players: Array.from({ length: 9 }, (_, i) => ({ playerId: `p${i}`, playProbability: 1, projectedMinutesIfActive: [34, 32, 30, 26, 24, 22, 20, 18, 14][i] })) });
  const input: NbaProjectionEngineInput = {
    snapshotId: "s1", capturedAt: "2026-08-05T18:00:00Z", playerCanonicalId: "nba:player:1", gameCanonicalId: "nba:game:401", season: SEASON,
    minutes: playerMinutes(alloc, "p0")!,
    posteriors: { points: rp("points", 20, 0.6), rebounds: rp("rebounds", 20, 0.25), assists: rp("assists", 20, 0.18), three_pointers_made: rp("threes", 20, 0.07) },
    priors,
  };
  const proj = computeNbaProjection(input);
  ok(!carriesForbiddenKey(proj), "PR3 projection is blind (no forbidden key) before decision");
  const d = evaluateFreshLine({
    projection: proj,
    identity: { playerCanonicalId: proj.playerCanonicalId, gameCanonicalId: proj.gameCanonicalId, market: "points", modelVersion: proj.modelVersion, projectionHash: proj.projectionHash },
    line: { line: 24.5, capturedAt: "2026-08-05T18:04:00Z", sportsbook: "book-a" },
    asOf: "2026-08-05T18:05:00Z",
  });
  ok(!carriesForbiddenKey(proj), "PR3 projection STILL blind after the decision runs");
  // The decision legitimately carries `line` and a `sportsbook` provenance label,
  // but no odds/price/EV/edge/payout key.
  const decisionForbidden = ["odds", "americanOdds", "price", "edge", "ev", "expectedValue", "payout", "impliedProb"];
  const keysDeep = JSON.stringify(d);
  ok(!decisionForbidden.some((k) => new RegExp(`"${k}"\\s*:`, "i").test(keysDeep)), "decision result carries no odds/price/EV/edge/payout key");
  ok(d.line === 24.5, "decision carries the line value");
}

console.log(`\npr4Isolation.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
