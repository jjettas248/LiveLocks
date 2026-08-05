// MLB Market Evidence Invariants — hard-gate invariants.
//
// Run: npx tsx server/mlb/marketEvidenceInvariants.test.ts

import {
  evaluateMarketEvidenceInvariants,
  type MarketEvidenceInput,
} from "./marketEvidenceInvariants";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// A fully-passing baseline (hits OVER, complete fresh state, real distribution)
const good: MarketEvidenceInput = {
  market: "hits",
  side: "OVER",
  currentStatKnown: true,
  liveStateComplete: true,
  liveStateFresh: true,
  modelMethod: "hit_distribution",
  fallbackUsed: false,
  capApplied: false,
  remainingOpportunity: 3,
  neededOutcomes: 1,
  hasFreshTwoSidedOdds: true,
};

{
  const r = evaluateMarketEvidenceInvariants(good);
  ok(r.passed, "baseline passes all invariants");
  ok(r.failedInvariants.length === 0, "no failed invariants on baseline");
}

// Each missing piece hard-fails, and a high (implicit) score cannot compensate
{
  const noState = evaluateMarketEvidenceInvariants({ ...good, currentStatKnown: false });
  ok(!noState.passed && noState.failedInvariants.includes("live_state_known"), "unknown live state fails");

  const incomplete = evaluateMarketEvidenceInvariants({ ...good, liveStateComplete: false });
  ok(!incomplete.passed && incomplete.failedInvariants.includes("live_state_complete"), "incomplete state fails");

  const stale = evaluateMarketEvidenceInvariants({ ...good, liveStateFresh: false });
  ok(!stale.passed && stale.failedInvariants.includes("live_state_fresh"), "stale state fails");

  const adHoc = evaluateMarketEvidenceInvariants({ ...good, modelMethod: null });
  ok(!adHoc.passed && adHoc.failedInvariants.includes("distribution_supported"), "missing distribution fails");

  const fallbackMethod = evaluateMarketEvidenceInvariants({ ...good, modelMethod: "static_fallback" as any });
  ok(!fallbackMethod.passed && fallbackMethod.failedInvariants.includes("distribution_supported"), "unsupported method fails");

  const fb = evaluateMarketEvidenceInvariants({ ...good, fallbackUsed: true });
  ok(!fb.passed && fb.failedInvariants.includes("no_prohibited_fallback"), "fallback used fails");

  const cap = evaluateMarketEvidenceInvariants({ ...good, capApplied: true });
  ok(!cap.passed && cap.failedInvariants.includes("no_prohibited_cap"), "cap applied fails");

  const noOpp = evaluateMarketEvidenceInvariants({ ...good, remainingOpportunity: null });
  ok(!noOpp.passed && noOpp.failedInvariants.includes("remaining_opportunity_present"), "missing remaining opportunity fails");

  const zeroOpp = evaluateMarketEvidenceInvariants({ ...good, remainingOpportunity: 0 });
  ok(!zeroOpp.passed && zeroOpp.failedInvariants.includes("remaining_opportunity_present"), "zero remaining opportunity fails");

  const insufficient = evaluateMarketEvidenceInvariants({ ...good, remainingOpportunity: 1, neededOutcomes: 3 });
  ok(!insufficient.passed && insufficient.failedInvariants.includes("remaining_opportunity_sufficient"), "insufficient remaining opportunity fails");

  const unknownNeeded = evaluateMarketEvidenceInvariants({ ...good, neededOutcomes: null });
  ok(!unknownNeeded.passed && unknownNeeded.failedInvariants.includes("remaining_opportunity_sufficient"), "OVER with unknown needed fails closed");

  const oneSided = evaluateMarketEvidenceInvariants({ ...good, hasFreshTwoSidedOdds: false });
  ok(!oneSided.passed && oneSided.failedInvariants.includes("two_sided_fresh_odds"), "one-sided/stale odds fails");
}

// Multiple failures reported together
{
  const many = evaluateMarketEvidenceInvariants({
    ...good,
    currentStatKnown: false,
    modelMethod: null,
    hasFreshTwoSidedOdds: false,
  });
  ok(!many.passed, "multi-failure not passed");
  ok(many.failedInvariants.length >= 3, "reports all failed invariants at once");
}

// UNDER does not require needed-outcomes sufficiency but still needs a projection
{
  const underOk = evaluateMarketEvidenceInvariants({ ...good, side: "UNDER", neededOutcomes: null });
  ok(underOk.passed, "UNDER passes without neededOutcomes when opportunity present");
  const underNoOpp = evaluateMarketEvidenceInvariants({ ...good, side: "UNDER", remainingOpportunity: null });
  ok(!underNoOpp.passed && underNoOpp.failedInvariants.includes("remaining_opportunity_present"), "UNDER still needs completed projection");
}

console.log(`\nmarketEvidenceInvariants.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
