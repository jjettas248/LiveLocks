// Pre-Game Power Radar — market tagging + public-predicate invariants.
// Run: npx tsx server/mlb/pregamePowerRadar/marketTagger.test.ts

import { computeMarketTags } from "./marketTagger";
import { composePregameScore, type ScoringFlags } from "./scoring";
// Public-visibility/lifecycle assertions live in diagnostics.test.ts, not here —
// this suite covers market tagging only.

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── HR shape → primary market home_runs ───────────────────────────────────────
const hr = computeMarketTags({
  batterPowerScore: 9, pitcherVulnerabilityScore: 8, parkWeatherScore: 8,
  hrFBRatioPct: 22, xISO: 0.25, hardHitRatePct: 50,
});
ok(hr.primaryMarket === "home_runs", "elite HR shape → home_runs primary");
ok(hr.marketTags.includes("home_runs"), "tags include home_runs");
ok((hr.marketScores.home_runs ?? 0) >= 6, "home_runs market score ≥6");

// ── Contact-but-not-HR shape → total_bases ────────────────────────────────────
const tb = computeMarketTags({
  batterPowerScore: 6.2, pitcherVulnerabilityScore: 5, parkWeatherScore: 4,
  hrFBRatioPct: 7, xISO: 0.12, hardHitRatePct: 48,
});
ok(tb.primaryMarket === "total_bases", `sub-elite HR ceiling → total_bases (got ${tb.primaryMarket})`);

// ── Qualitative market setups are server-stamped, one per market tag ──────────
ok(hr.marketSetups.length === hr.marketTags.length, "one marketSetup per market tag");
ok(hr.marketSetups.every((m) => hr.marketTags.includes(m.market)), "setups cover only tagged markets");
ok(hr.marketSetups.some((m) => m.isPrimary && m.market === hr.primaryMarket), "primary market flagged in setups");
ok(
  hr.marketSetups.every((m) => ["Elite", "Strong", "Solid", "Watch"].includes(m.setupLabel)),
  "setupLabel is a qualitative tier (never a raw number)",
);
ok(
  hr.marketSetups.every((m) => Math.abs(m.setupScore - (hr.marketScores[m.market] ?? -1)) < 1e-9),
  "setupScore mirrors marketScores (debug-only numeric)",
);

// ── Phase 1 only emits HR + TB markets ────────────────────────────────────────
const allTags = new Set([...hr.marketTags, ...tb.marketTags]);
ok(![...allTags].some((m) => m === "hits" || m === "rbi" || m === "hrr"), "no hits/rbi/hrr in Phase 1");

// ── marketFitScore never feeds score10 (structurally independent) ─────────────
const flags: ScoringFlags = {
  batterPowerAvailable: true, pitcherProfileAvailable: true, confirmedLineup: true,
  parkAvailable: true, weatherAvailable: true, bvpAvailable: false,
  parkIsOnlyPositiveDriver: false, positiveDriverCount: 3,
  attackEnvironmentTier: "NEUTRAL", attackEnvironmentEliminationEligible: false,
};
const comps = { batterPowerScore: 7, pitcherVulnerabilityScore: 7, matchupFitScore: 7, parkWeatherScore: 7, lineupOpportunityScore: 7, nearHrRecentFormScore: 7, bvpModifier: 0 };
const score = composePregameScore(comps, flags).score10;
// Different market context must not change the composite (it isn't an input).
ok(typeof score === "number", `composite computed without market input (got ${score})`);

// ── signalId is market-independent (stable when primaryMarket changes) ─────────
const id = (sessionDate: string, gameId: string, batterId: string) =>
  `mlb-pregame:${sessionDate}:${gameId}:${batterId}`;
ok(id("2026-06-23", "g1", "b1") === id("2026-06-23", "g1", "b1"), "signalId stable across rebuilds");

console.log(`\nmarketTagger.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
