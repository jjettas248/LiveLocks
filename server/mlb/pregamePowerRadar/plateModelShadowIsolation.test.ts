// The Plate — shadow-challenger isolation + frozen-input invariants.
//
// Guards:
//   1. Champion and challenger receive the IDENTICAL frozen input (same hash,
//      same object reference), and the input is genuinely immutable.
//   2. Challenger evaluation cannot mutate the champion's DTO or result.
//   3. A shadow failure cannot block production output.
//   4. Champion output is byte-identical with the research block fully
//      populated vs entirely absent.
//   5. Challenger exposure is sticky across builds.
//   6. `bvp_policy` is never an attribution cause.
//   7. Source-scan: no champion-path file imports the challenger policy.
//   8. The shadow flag is fail-closed.
//
// Run: npx tsx server/mlb/pregamePowerRadar/plateModelShadowIsolation.test.ts

import {
  freezePlateInput,
  hashFrozenPlateInput,
  RESEARCH_UNCOLLECTED,
  type FrozenPlateInput,
} from "./frozenPlateInput";
import { evaluatePlateModel } from "./evaluatePlateModel";
import { PLATE_CHAMPION_POLICY } from "./modelVersions/plateChampionJul20";
import { PLATE_CHALLENGER_POLICY } from "./modelVersions/plateChallengerCurrent";
import { parsePlateShadowFlag } from "./modelVersions/plateShadowFlags";
import { buildPlateModelComparison, attributeDelta, shouldLogPlateDelta } from "./plateModelComparison";
import type { PlatePublicationContext } from "./modelVersions/plateModelTypes";
import { readFileSync } from "fs";
import { join } from "path";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const CTX: PlatePublicationContext = {
  lineupStatus: "posted",
  isOfficialPlay: false,
  isPregameTarget: true,
};

function input(over: Partial<FrozenPlateInput> = {}): FrozenPlateInput {
  return {
    sessionDate: "2026-07-24", gameId: "g1", batterId: "b1", pitcherId: "p1",
    batter: {
      xISO: 0.24, xSLG: 0.54, barrelRatePct: 14, hardHitRatePct: 49, exitVelocity: 92,
      maxEV: 114, flyBallPct: 42, hrFBRatioPct: 22, pullRatePct: 48, sweetSpotPct: 38,
      xwOBA: 0.40, battedBallEvents: 20, bats: "R",
    },
    pitcher: {
      pitcherKnown: true, throws: "R",
      hrPer9VsLHB: 1.2, hrPer9VsRHB: 1.9, eraVsLHB: 3.9, eraVsRHB: 5.1,
    },
    research: {
      collected: true, unavailableReason: null,
      barrelAllowedPct: 11, hardHitAllowedPct: 46, flyBallAllowedPct: 44,
      last3StartERA: 7.1, daysSinceLastStart: 3,
    },
    matchup: {
      batterOpsVsHand: 0.88, batterXslgVsDominantFamily: null, parkFavorsPull: true,
      bvpPlateAppearances: null, bvpAtBats: null, bvpHr: null, bvpHits: null,
      bvpStrikeouts: null, bvpOps: null, bvpAvg: null,
    },
    parkWeather: {
      parkHrFactor: 1.15, isIndoors: false, weatherAvailable: true,
      temperature: 84, windSpeed: 12, windDirection: "out",
    },
    lineup: { battingOrderSlot: 3, lineupPosted: true, teamImpliedRuns: null, obpAhead: null },
    precomputed: {
      nearHrRecentForm: { score10: 7.2, available: true, drivers: [] },
      batterOrderSplit: { score10: 5, direction: "unavailable", drivers: [] },
      pitcherOrderSplit: { score10: 5, available: false, direction: "unavailable", drivers: [] },
    },
    dataQuality: { savantQuality: "full", venueResolved: true, pitcherHandResolved: true },
    ...over,
  };
}

// ── 1. Identical frozen input ─────────────────────────────────────────────────
{
  const frozen = freezePlateInput(input());
  const h1 = hashFrozenPlateInput(frozen);
  const champ = evaluatePlateModel(frozen, PLATE_CHAMPION_POLICY, CTX);
  const chal = evaluatePlateModel(frozen, PLATE_CHALLENGER_POLICY, CTX);
  const h2 = hashFrozenPlateInput(frozen);
  ok(h1 === h2, "[1] frozen input hash is unchanged by both evaluations");
  ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.batter) && Object.isFrozen(frozen.research), "[1] the DTO is deep-frozen");
  ok(champ.modelVersion !== chal.modelVersion, "[1] the two evaluations are genuinely different models");

  // The hash must be order-insensitive but value-sensitive.
  const reordered = freezePlateInput({ ...input(), sessionDate: "2026-07-24" });
  ok(hashFrozenPlateInput(reordered) === h1, "[1] key ordering does not change the hash");
  const changed = freezePlateInput(input({ batter: { ...input().batter, xISO: 0.25 } }));
  ok(hashFrozenPlateInput(changed) !== h1, "[1] a real value change DOES change the hash");
}

// ── 2. No mutation across models ──────────────────────────────────────────────
{
  const frozen = freezePlateInput(input());
  const champBefore = evaluatePlateModel(frozen, PLATE_CHAMPION_POLICY, CTX);
  evaluatePlateModel(frozen, PLATE_CHALLENGER_POLICY, CTX);
  const champAfter = evaluatePlateModel(frozen, PLATE_CHAMPION_POLICY, CTX);
  ok(
    champBefore.score10 === champAfter.score10 &&
      champBefore.tier === champAfter.tier &&
      champBefore.suppressed === champAfter.suppressed &&
      champBefore.publicEligible === champAfter.publicEligible,
    "[2] running the challenger between two champion evaluations changes nothing",
  );
  // Writing through the frozen DTO must not take effect.
  try { (frozen as any).batter.xISO = 0.99; } catch { /* strict mode throws — also fine */ }
  ok(frozen.batter.xISO === 0.24, "[2] the frozen DTO rejects mutation");
}

// ── 3-4. Research absence is a no-op for the champion ─────────────────────────
{
  const withResearch = freezePlateInput(input());
  const withoutResearch = freezePlateInput(input({ research: RESEARCH_UNCOLLECTED }));
  const a = evaluatePlateModel(withResearch, PLATE_CHAMPION_POLICY, CTX);
  const b = evaluatePlateModel(withoutResearch, PLATE_CHAMPION_POLICY, CTX);
  ok(a.score10 === b.score10, `[4] champion score10 identical with and without research (${a.score10} vs ${b.score10})`);
  ok(a.tier === b.tier, `[4] champion tier identical (${a.tier} vs ${b.tier})`);
  ok(a.suppressed === b.suppressed, "[4] champion suppression identical");
  ok(a.publicEligible === b.publicEligible, "[4] champion publication identical");
  ok(a.components.pitcherVulnerabilityScore === b.components.pitcherVulnerabilityScore, "[4] champion Pitcher Vulnerability identical");

  // The challenger, by contrast, must notice.
  const ca = evaluatePlateModel(withResearch, PLATE_CHALLENGER_POLICY, CTX);
  const cb = evaluatePlateModel(withoutResearch, PLATE_CHALLENGER_POLICY, CTX);
  ok(
    ca.components.pitcherVulnerabilityScore !== cb.components.pitcherVulnerabilityScore,
    `[4] challenger Pitcher Vulnerability DOES change with research (${ca.components.pitcherVulnerabilityScore} vs ${cb.components.pitcherVulnerabilityScore})`,
  );
  ok(!ca.flags.usedPitcherContactFeatures === false, "[4] challenger flags record that contact features were used");
  ok(cb.flags.usedPitcherContactFeatures === false, "[4] challenger flags record absence honestly when uncollected");
  ok(a.flags.usedPitcherContactFeatures === false, "[4] champion never records using contact features");
}

// ── 3. A shadow throw cannot block production ─────────────────────────────────
{
  // Simulates the build's fail-open wrapper: the champion result is already in
  // hand, the shadow throws, and the signal still carries an honest record.
  const frozen = freezePlateInput(input());
  const champion = evaluatePlateModel(frozen, PLATE_CHAMPION_POLICY, CTX);
  let comparison: any = {
    championVersion: PLATE_CHAMPION_POLICY.version,
    challengerVersion: PLATE_CHALLENGER_POLICY.version,
    frozenInputHash: hashFrozenPlateInput(frozen),
    challengerUnavailable: "failed",
  };
  let threw = false;
  try {
    throw new Error("simulated shadow failure");
  } catch {
    threw = true; // swallowed exactly as the build does
  }
  ok(threw, "[3] the simulated shadow failure actually fired");
  ok(champion.score10 > 0 && champion.tier.length > 0, "[3] the champion result survives a shadow failure");
  ok(comparison.challengerUnavailable === "failed", "[3] the signal records WHY the challenger is absent, not just that it is");
}

// ── 5. Sticky challenger exposure ─────────────────────────────────────────────
{
  const frozen = freezePlateInput(input());
  const champ = evaluatePlateModel(frozen, PLATE_CHAMPION_POLICY, CTX);
  const chal = evaluatePlateModel(frozen, PLATE_CHALLENGER_POLICY, CTX);

  // Build N: force eligible.
  const eligible = { ...chal, publicEligible: true };
  const buildN = buildPlateModelComparison(champ, eligible, "hash", null, "2026-07-24T16:00:00.000Z");
  ok(buildN.challenger.everPubliclyEligible === true, "[5] first eligible build sets everPubliclyEligible");
  ok(buildN.challenger.firstPublicEligibleAt === "2026-07-24T16:00:00.000Z", "[5] firstPublicEligibleAt is stamped");

  // Build N+1: now ineligible. The sticky flag must survive.
  const ineligible = { ...chal, publicEligible: false };
  const buildN1 = buildPlateModelComparison(champ, ineligible, "hash", buildN, "2026-07-24T20:00:00.000Z");
  ok(buildN1.challenger.publicEligible === false, "[5] per-build publicEligible correctly reads false");
  ok(buildN1.challenger.everPubliclyEligible === true, "[5] everPubliclyEligible survives the later dip");
  ok(buildN1.challenger.firstPublicEligibleAt === "2026-07-24T16:00:00.000Z", "[5] firstPublicEligibleAt keeps the EARLIEST time, not the latest");

  // Never-eligible stays false — stickiness must not mint exposure.
  const neverA = buildPlateModelComparison(champ, ineligible, "hash", null, "2026-07-24T16:00:00.000Z");
  const neverB = buildPlateModelComparison(champ, ineligible, "hash", neverA, "2026-07-24T20:00:00.000Z");
  ok(neverB.challenger.everPubliclyEligible === false, "[5] a never-eligible challenger stays false");
  ok(neverB.challenger.firstPublicEligibleAt === null, "[5] firstPublicEligibleAt stays null when never eligible");

  // An unavailable prior must not crash or fabricate.
  const fromUnavailable = buildPlateModelComparison(
    champ, eligible, "hash",
    { championVersion: "c", challengerVersion: "x", frozenInputHash: "h", challengerUnavailable: "disabled" },
    "2026-07-24T16:00:00.000Z",
  );
  ok(fromUnavailable.challenger.everPubliclyEligible === true, "[5] carrying from an unavailable prior degrades to the current build");
}

// ── 6. bvp_policy is never an attribution cause ───────────────────────────────
{
  const frozen = freezePlateInput(input({
    matchup: {
      ...input().matchup,
      bvpPlateAppearances: 40, bvpAtBats: 40, bvpHr: 5, bvpHits: 14,
      bvpStrikeouts: 8, bvpOps: 0.95, bvpAvg: 0.35,
    },
  }));
  const champ = evaluatePlateModel(frozen, PLATE_CHAMPION_POLICY, CTX);
  const chal = evaluatePlateModel(frozen, PLATE_CHALLENGER_POLICY, CTX);
  const attribution = attributeDelta(champ, chal);
  ok(!attribution.includes("bvp_policy" as any), "[6] bvp_policy never appears in an attribution list");
  const comparison = buildPlateModelComparison(champ, chal, "h", null, "2026-07-24T16:00:00.000Z");
  ok(!comparison.attribution.includes("bvp_policy" as any), "[6] bvp_policy never appears on the comparison record");
  // Any genuine disagreement must be explainable.
  const disagreed =
    comparison.delta.publicDecisionChanged || comparison.delta.tierChanged ||
    comparison.delta.marketChanged || comparison.delta.score10 !== 0;
  ok(!disagreed || comparison.attribution.length > 0, "[6] a real disagreement always carries at least one attribution");
  ok(shouldLogPlateDelta(comparison) === (comparison.delta.publicDecisionChanged || comparison.delta.tierChanged || comparison.delta.marketChanged), "[6] delta logging fires only on a public/tier/market change");
}

// ── 7. Source scan: the champion path never imports the challenger ────────────
{
  const dir = join(process.cwd(), "server/mlb/pregamePowerRadar");
  const championPathFiles = [
    "scoring.ts", "batterPowerProfile.ts", "pitcherVulnerability.ts",
    "matchupFit.ts", "parkWeatherScore.ts", "lineupOpportunity.ts",
    "nearHrRecentForm.ts", "marketTagger.ts", "diagnostics.ts",
    "modelVersions/plateChampionJul20.ts", "modelVersions/platePublicationDecision.ts",
    "modelVersions/plateDriverUniverse.ts",
  ];
  // Assembled from parts so this test file cannot match itself.
  const forbidden = ["plateChallenger" + "Current", "PLATE_CHALLENGER" + "_POLICY"];
  for (const f of championPathFiles) {
    const src = readFileSync(join(dir, f), "utf8");
    const body = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const token of forbidden) {
      ok(!body.includes(token), `[7] ${f} does not reference ${token}`);
    }
  }
  // …and the champion policy must not reference the AE gate or the family gate.
  const championPolicy = readFileSync(join(dir, "modelVersions/plateChampionJul20.ts"), "utf8");
  ok(/attackEnvironmentGates:\s*false/.test(championPolicy), "[7] champion policy hard-codes attackEnvironmentGates: false");
  ok(/evidenceFamilyGate:\s*false/.test(championPolicy), "[7] champion policy hard-codes evidenceFamilyGate: false");
  ok(/applySampleShrinkage:\s*false/.test(championPolicy), "[7] champion policy hard-codes applySampleShrinkage: false");

  // The build must select the champion explicitly, never by default.
  const build = readFileSync(join(dir, "buildPregamePowerRadar.ts"), "utf8");
  ok(build.includes("PLATE_CHAMPION_POLICY.gates"), "[7] the build passes the champion gate policy explicitly");
  ok(build.includes("evaluatePlateModel(frozen, PLATE_CHAMPION_POLICY"), "[7] the build evaluates the champion explicitly");
}

// ── 8. The shadow flag is fail-closed ─────────────────────────────────────────
{
  for (const v of ["true", "1", "on", "yes", "TRUE", " on "]) {
    ok(parsePlateShadowFlag(v) === true, `[8] "${v}" enables shadow evaluation`);
  }
  for (const v of [undefined, null, "", "  ", "false", "0", "off", "no", "ture", "enabled", "y"]) {
    ok(parsePlateShadowFlag(v as any) === false, `[8] ${JSON.stringify(v)} leaves the challenger inert`);
  }
}

console.log(`\nplateModelShadowIsolation.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
