// Official MLB Recommendation Firewall — invariants.
//
// Run: npx tsx server/mlb/episodes/mlbOfficialRecommendationFirewall.test.ts

import {
  evaluateOfficialRecommendationEligibility,
  assertOfficialRecommendationEligible,
  MlbOfficialRecommendationRejectedError,
  type MlbOfficialRecommendationCandidate,
  type MlbFirewallContext,
} from "./mlbOfficialRecommendationFirewall";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function baseCandidate(overrides: Partial<MlbOfficialRecommendationCandidate> = {}): MlbOfficialRecommendationCandidate {
  return {
    sourceType: "sportsbook",
    sportsbook: "draftkings",
    line: 5.5,
    americanOdds: -120,
    oddsFetchedAt: "2026-07-29T22:00:00.000Z",
    projection: 6.2,
    modelProbability: 0.58,
    recommendedSide: "OVER",
    modelVersion: "mound_v1",
    contractVersion: "episode_v1",
    expiresAt: null,
    dataQuality: "complete",
    ...overrides,
  };
}

const context: MlbFirewallContext = { now: new Date("2026-07-29T22:00:30.000Z"), currentGameStatus: "pregame" };

// ── Positive case ────────────────────────────────────────────────────────
{
  const r = evaluateOfficialRecommendationEligibility(baseCandidate(), context);
  ok(r.eligible === true && r.violations.length === 0, "a fully valid candidate is eligible with zero violations");
}

// ── Rejected without sportsbook ──────────────────────────────────────────
{
  const r = evaluateOfficialRecommendationEligibility(baseCandidate({ sportsbook: "" as any }), context);
  ok(!r.eligible && r.violations.includes("MISSING_SPORTSBOOK"), "empty sportsbook is rejected");
}

// ── Rejected without a valid price ───────────────────────────────────────
{
  const r1 = evaluateOfficialRecommendationEligibility(baseCandidate({ americanOdds: 0 }), context);
  ok(!r1.eligible && r1.violations.includes("INVALID_ODDS"), "zero american odds is rejected");
  const r2 = evaluateOfficialRecommendationEligibility(baseCandidate({ americanOdds: NaN }), context);
  ok(!r2.eligible && r2.violations.includes("INVALID_ODDS"), "NaN american odds is rejected");
  const r3 = evaluateOfficialRecommendationEligibility(baseCandidate({ americanOdds: 50 }), context);
  ok(!r3.eligible && r3.violations.includes("INVALID_ODDS"), "american odds with magnitude < 100 is rejected (not a real price)");
}

// ── Rejected without a real fetch timestamp ──────────────────────────────
{
  const r1 = evaluateOfficialRecommendationEligibility(baseCandidate({ oddsFetchedAt: "" }), context);
  ok(!r1.eligible && r1.violations.includes("MISSING_FETCH_TIMESTAMP"), "empty fetch timestamp is rejected");
  const r2 = evaluateOfficialRecommendationEligibility(baseCandidate({ oddsFetchedAt: "not-a-date" }), context);
  ok(!r2.eligible && r2.violations.includes("MISSING_FETCH_TIMESTAMP"), "unparseable fetch timestamp is rejected");
}

// ── Rejected when stale ───────────────────────────────────────────────────
{
  const staleCtx: MlbFirewallContext = { now: new Date("2026-07-29T22:10:00.000Z"), currentGameStatus: "pregame" };
  const r = evaluateOfficialRecommendationEligibility(
    baseCandidate({ oddsFetchedAt: "2026-07-29T22:00:00.000Z" }), // 10 minutes old
    staleCtx,
  );
  ok(!r.eligible && r.violations.includes("ODDS_STALE"), "odds older than the pregame TTL are rejected as stale");
}

// ── Rejected when synthetic ───────────────────────────────────────────────
{
  const r1 = evaluateOfficialRecommendationEligibility(baseCandidate({ sourceType: "model" as any }), context);
  ok(!r1.eligible && r1.violations.includes("SYNTHETIC_SOURCE"), "non-sportsbook sourceType is rejected");

  // The confirmed real-world bug: liveGameOrchestrator.ts falls back to the
  // literal string "odds_api" when the real sportsbook is unknown. That must
  // never satisfy this firewall.
  const r2 = evaluateOfficialRecommendationEligibility(baseCandidate({ sportsbook: "odds_api" as any }), context);
  ok(!r2.eligible && r2.violations.includes("UNAPPROVED_SPORTSBOOK"),
    "'odds_api' placeholder label is rejected, not treated as a real book");
}

// ── Projection/side/probability consistency ──────────────────────────────
{
  const r1 = evaluateOfficialRecommendationEligibility(
    baseCandidate({ recommendedSide: "UNDER", projection: 6.2, line: 5.5 }),
    context,
  );
  ok(!r1.eligible && r1.violations.includes("SIDE_PROJECTION_MISMATCH"),
    "UNDER recommended with a projection above the line is rejected");

  const r2 = evaluateOfficialRecommendationEligibility(baseCandidate({ modelProbability: 0.5 }), context);
  ok(!r2.eligible && r2.violations.includes("PROBABILITY_DOES_NOT_FAVOR_SIDE"),
    "exactly-0.5 probability does not favor either side");

  const r3 = evaluateOfficialRecommendationEligibility(baseCandidate({ modelProbability: 1.2 }), context);
  ok(!r3.eligible && r3.violations.includes("INVALID_PROBABILITY"), "probability outside (0,1) is rejected");

  const r4 = evaluateOfficialRecommendationEligibility(
    baseCandidate({ recommendedSide: "UNDER", projection: 4.0, line: 5.5, modelProbability: 0.65 }),
    context,
  );
  ok(r4.eligible, "UNDER with projection below the line and probability > 0.5 is eligible");
}

// ── Version metadata required ────────────────────────────────────────────
{
  const r1 = evaluateOfficialRecommendationEligibility(baseCandidate({ modelVersion: "" }), context);
  ok(!r1.eligible && r1.violations.includes("MISSING_MODEL_VERSION"), "empty model version is rejected");
  const r2 = evaluateOfficialRecommendationEligibility(baseCandidate({ contractVersion: "" }), context);
  ok(!r2.eligible && r2.violations.includes("MISSING_CONTRACT_VERSION"), "empty contract version is rejected");
}

// ── Current game state controls freshness (not a stored value) ──────────
{
  const fetchedAt = "2026-07-29T22:00:00.000Z";
  const oneMinuteLater = new Date("2026-07-29T22:01:00.000Z"); // 60s old regardless of context

  const pregameResult = evaluateOfficialRecommendationEligibility(
    baseCandidate({ oddsFetchedAt: fetchedAt }),
    { now: oneMinuteLater, currentGameStatus: "pregame" }, // 2min TTL -> still fresh
  );
  const liveResult = evaluateOfficialRecommendationEligibility(
    baseCandidate({ oddsFetchedAt: fetchedAt }),
    { now: oneMinuteLater, currentGameStatus: "live" }, // 30s TTL -> stale
  );
  ok(pregameResult.eligible, "60s-old odds are fresh when the reader's current game state is pregame");
  ok(!liveResult.eligible && liveResult.violations.includes("ODDS_STALE"),
    "the SAME 60s-old odds are stale once the reader's current game state is live — freshness is reader-driven, not stored");
}

// ── Unknown game status always fails closed ──────────────────────────────
{
  const r = evaluateOfficialRecommendationEligibility(baseCandidate(), { now: context.now, currentGameStatus: "unknown" });
  ok(!r.eligible && r.violations.includes("ODDS_STALE"), "an unknown current game status can never confirm freshness — fails closed");
}

// ── assertOfficialRecommendationEligible throws with violations attached ──
{
  let threw = false;
  try {
    assertOfficialRecommendationEligible(baseCandidate({ sportsbook: "odds_api" as any }), context);
  } catch (e) {
    threw = e instanceof MlbOfficialRecommendationRejectedError &&
      (e as MlbOfficialRecommendationRejectedError).violations.includes("UNAPPROVED_SPORTSBOOK");
  }
  ok(threw, "assertOfficialRecommendationEligible throws MlbOfficialRecommendationRejectedError carrying the violation list");

  let didNotThrow = true;
  try {
    assertOfficialRecommendationEligible(baseCandidate(), context);
  } catch {
    didNotThrow = false;
  }
  ok(didNotThrow, "assertOfficialRecommendationEligible does not throw for a valid candidate");
}

console.log(`\nmlbOfficialRecommendationFirewall.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
