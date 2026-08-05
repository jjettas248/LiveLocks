// MLB Production Lane Authority — invariants.
//
// Run: npx tsx server/mlb/mlbProductionLane.test.ts

import {
  evaluateMlbProductionLane,
  isIntegerLine,
  type MlbProductionLaneInput,
} from "./mlbProductionLane";
import type { PairedTwoSidedQuote } from "./oddsProbability";
import type { MarketEvidenceInput } from "./marketEvidenceInvariants";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const freshQuote = (over = -110, under = -110, line = 2.5): PairedTwoSidedQuote => ({
  book: "draftkings", line, overOdds: over, underOdds: under,
  sourceTimestamp: 1_700_000_000_000, ageMs: 5_000,
});

const goodEvidence = (market: any = "hits", side: any = "OVER"): MarketEvidenceInput => ({
  market, side,
  currentStatKnown: true, liveStateComplete: true, liveStateFresh: true,
  modelMethod: "hit_distribution", fallbackUsed: false, capApplied: false,
  remainingOpportunity: 3, neededOutcomes: 1, hasFreshTwoSidedOdds: true,
});

// A hits candidate that clears every gate EXCEPT calibration → official via
// provisional-uncalibrated, stamped raw_provisional.
function hitsInput(overrides: Partial<MlbProductionLaneInput> = {}): MlbProductionLaneInput {
  return {
    market: "hits", side: "OVER", line: 2.5, inning: 6, gameStatus: "live",
    baseEligible: true, candidateProbabilityPct: 62, calibratedProbabilityPct: null,
    quote: freshQuote(), evidence: goodEvidence(), ...overrides,
  };
}

// isIntegerLine
{
  ok(isIntegerLine(6) && isIntegerLine(1), "integer lines detected");
  ok(!isIntegerLine(5.5) && !isIntegerLine(1.5), "half lines not integer");
}

// Provisional hits official (raw_provisional, never calibrated)
{
  const r = evaluateMlbProductionLane(hitsInput());
  ok(r.lane === "official", "hits clears gates → official (provisional)");
  ok(r.probabilitySemantics === "raw_provisional", "uncalibrated ⇒ raw_provisional");
  ok(r.provisionalTag === "provisional_uncalibrated", "provisional tag set");
  ok(r.calibratedProbabilityPct === null, "calibrated stays null (never identity copy)");
  ok(r.modelEdgePctPoints !== null && Math.abs(r.modelEdgePctPoints - 12) < 1e-6, "edge = 62 - 50 = 12pp");
  ok(r.edgeVersion === "novig_v1", "edge version stamped");
}

// Innings 1-3 can NEVER be official
{
  const r = evaluateMlbProductionLane(hitsInput({ inning: 2 }));
  ok(r.lane !== "official", "inning 2 not official");
  ok(r.actionabilityReasons.includes("early_inning_watch_only"), "early_inning reason present");
  ok(r.lane === "watch", "official-mode market failing gate → watch");
}

// Shadow markets never official even with perfect evidence
{
  const r = evaluateMlbProductionLane(hitsInput({
    market: "total_bases", evidence: goodEvidence("total_bases", "OVER"),
  }));
  ok(r.lane === "shadow", "total_bases always shadow");
  ok(r.actionabilityReasons.includes("market_shadow"), "market_shadow reason");
}

// Integer (pushable) line fails closed until win/push/loss modeled
{
  const r = evaluateMlbProductionLane(hitsInput({ line: 2, quote: freshQuote(-110, -110, 2) }));
  ok(r.lineIsInteger === true, "line 2 is integer");
  ok(r.lane !== "official", "integer line not official");
  ok(r.actionabilityReasons.includes("integer_line_push_unmodeled"), "integer push reason present");
}

// No-vig unavailable (one-sided) → non-actionable
{
  const r = evaluateMlbProductionLane(hitsInput({ quote: freshQuote(-110, null as any) }));
  ok(r.noVigBookProbability === null, "no-vig null when one-sided");
  ok(r.modelEdgePctPoints === null, "edge null when no-vig unavailable (never 0)");
  ok(r.lane !== "official", "one-sided price → not official");
  ok(r.actionabilityReasons.includes("price_ineligible"), "price_ineligible reason");
}

// Failed evidence invariant blocks official (score cannot compensate — no score here)
{
  const r = evaluateMlbProductionLane(hitsInput({
    evidence: { ...goodEvidence(), currentStatKnown: false },
  }));
  ok(r.lane !== "official", "missing live state → not official");
  ok(r.actionabilityReasons.includes("evidence:live_state_known"), "evidence failure surfaced");
}

// Base-ineligible blocks official
{
  const r = evaluateMlbProductionLane(hitsInput({ baseEligible: false }));
  ok(r.lane !== "official", "base ineligible → not official");
  ok(r.actionabilityReasons.includes("base_ineligible"), "base_ineligible reason");
}

// Calibrated path flips semantics
{
  const r = evaluateMlbProductionLane(hitsInput({ calibratedProbabilityPct: 62 }));
  ok(r.probabilitySemantics === "outcome_calibrated", "calibrated ⇒ outcome_calibrated");
  ok(r.provisionalTag === null, "no provisional tag when calibrated");
}

// Probability below floor blocks official
{
  const r = evaluateMlbProductionLane(hitsInput({ candidateProbabilityPct: 51 }));
  ok(r.lane !== "official", "prob below floor → not official");
  ok(r.actionabilityReasons.includes("probability_below_floor"), "probability_below_floor reason");
}

console.log(`\nmlbProductionLane.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
