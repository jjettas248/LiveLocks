// Mound V2 (shadow) — EXECUTABILITY invariants (Mound V2 purity pass). The
// counterpart to moundV2ModelPolicy.test.ts: proves this module answers a
// completely separate, downstream question — never influences the model's
// own side/qualification, and has no mechanism to write back into it.
//
// Run: npx tsx server/mlb/pregame/mound/v2/moundV2Executability.test.ts

import {
  applyMoundV2Executability,
  MOUND_V2_DEFAULT_EXECUTABILITY_POLICY,
  type MoundV2ExecutabilityInput,
} from "./moundV2Executability";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const NOW = new Date("2026-07-30T20:00:00.000Z");

function input(over: Partial<MoundV2ExecutabilityInput> = {}): MoundV2ExecutabilityInput {
  return {
    side: "OVER",
    overPrice: -120,
    underPrice: 100,
    sportsbook: "draftkings",
    oddsFetchedAt: "2026-07-30T19:58:00.000Z", // 2 minutes before `now`
    now: NOW,
    ...over,
  };
}

// ── A fresh, fully-provenanced price is executable ──────────────────────────
{
  const result = applyMoundV2Executability(MOUND_V2_DEFAULT_EXECUTABILITY_POLICY, input());
  ok(result.executable === true && result.failureReason === null, "a fresh price with full provenance is executable, with no failure reason");
  ok(result.sportsbook === "draftkings" && result.price === -120 && result.fetchedAt === "2026-07-30T19:58:00.000Z", "the real sportsbook/price/timestamp are carried through exactly");
  ok(result.policyVersion === MOUND_V2_DEFAULT_EXECUTABILITY_POLICY.policyVersion, "the result carries the real policy version it was evaluated under");
}

// ── side reads the correct price: OVER reads overPrice, UNDER reads underPrice — never crossed ──
{
  const overResult = applyMoundV2Executability(MOUND_V2_DEFAULT_EXECUTABILITY_POLICY, input({ side: "OVER", overPrice: -150, underPrice: 130 }));
  ok(overResult.price === -150, `side=OVER reads overPrice, never underPrice (got ${overResult.price})`);

  const underResult = applyMoundV2Executability(MOUND_V2_DEFAULT_EXECUTABILITY_POLICY, input({ side: "UNDER", overPrice: -150, underPrice: 130 }));
  ok(underResult.price === 130, `side=UNDER reads underPrice, never overPrice (got ${underResult.price})`);
}

// ── side: null (model abstained) -> not_applicable, regardless of price ────
{
  const result = applyMoundV2Executability(MOUND_V2_DEFAULT_EXECUTABILITY_POLICY, input({ side: null }));
  ok(result.executable === false && result.failureReason === "not_applicable", "a null side (model abstained) is honestly not_applicable — executability was never a live question here");
  ok(result.sportsbook === null && result.price === null && result.fetchedAt === null, "not_applicable carries no stray sportsbook/price/timestamp fields");
}

// ── Missing price -> missing_price, sportsbook/timestamp still reported ────
{
  const result = applyMoundV2Executability(MOUND_V2_DEFAULT_EXECUTABILITY_POLICY, input({ overPrice: null }));
  ok(result.executable === false && result.failureReason === "missing_price", "a null price for the model's own side is honestly missing_price, never fabricated");
  ok(result.sportsbook === "draftkings" && result.fetchedAt === "2026-07-30T19:58:00.000Z", "missing_price still reports the real sportsbook/timestamp that WAS available, for diagnosability");
}

// ── Missing provenance -> missing_provenance ────────────────────────────────
{
  const noBook = applyMoundV2Executability(MOUND_V2_DEFAULT_EXECUTABILITY_POLICY, input({ sportsbook: null }));
  ok(noBook.executable === false && noBook.failureReason === "missing_provenance", "a null sportsbook is missing_provenance");

  const noTimestamp = applyMoundV2Executability(MOUND_V2_DEFAULT_EXECUTABILITY_POLICY, input({ oddsFetchedAt: null }));
  ok(noTimestamp.executable === false && noTimestamp.failureReason === "missing_provenance", "a null fetch timestamp is ALSO missing_provenance");
}

// ── Stale odds -> odds_too_stale ─────────────────────────────────────────────
{
  const staleResult = applyMoundV2Executability(MOUND_V2_DEFAULT_EXECUTABILITY_POLICY, input({ oddsFetchedAt: "2026-07-28T00:00:00.000Z" })); // ~44h before now
  ok(staleResult.executable === false && staleResult.failureReason === "odds_too_stale", "a price far older than maximumOddsAgeMs is odds_too_stale");
  ok(staleResult.sportsbook === "draftkings" && staleResult.price === -120, "odds_too_stale still reports the real (but stale) sportsbook/price for diagnosability");
}

// ── Boundary: exactly at the max age is still executable (>, not >=) ───────
{
  const exactBoundary = new Date(NOW.getTime() - MOUND_V2_DEFAULT_EXECUTABILITY_POLICY.maximumOddsAgeMs);
  const result = applyMoundV2Executability(MOUND_V2_DEFAULT_EXECUTABILITY_POLICY, input({ oddsFetchedAt: exactBoundary.toISOString() }));
  ok(result.executable === true, "a price exactly at the max age boundary is still executable (the staleness check is strictly >, never >=)");

  const oneMsOver = new Date(exactBoundary.getTime() - 1);
  const overResult = applyMoundV2Executability(MOUND_V2_DEFAULT_EXECUTABILITY_POLICY, input({ oddsFetchedAt: oneMsOver.toISOString() }));
  ok(overResult.executable === false && overResult.failureReason === "odds_too_stale", "one millisecond past the boundary correctly flips to stale");
}

// ── Never throws, even on a malformed timestamp ─────────────────────────────
{
  let threw = false;
  let result: ReturnType<typeof applyMoundV2Executability> | undefined;
  try {
    result = applyMoundV2Executability(MOUND_V2_DEFAULT_EXECUTABILITY_POLICY, input({ oddsFetchedAt: "not-a-real-date" }));
  } catch {
    threw = true;
  }
  ok(!threw, "applyMoundV2Executability never throws, even for a malformed timestamp string");
  ok(result?.executable === false && result?.failureReason === "odds_too_stale", "a malformed timestamp produces a NaN age, which safely fails closed as stale rather than crashing or defaulting to executable");
}

// ── One-way data flow: executability has no field that could write back into a model decision ──
{
  const result = applyMoundV2Executability(MOUND_V2_DEFAULT_EXECUTABILITY_POLICY, input());
  const keys = Object.keys(result).sort();
  ok(
    JSON.stringify(keys) === JSON.stringify(["executable", "failureReason", "fetchedAt", "policyVersion", "price", "sportsbook"].sort()),
    `MoundV2ExecutabilityResult has exactly these keys — no "side", "modelQualified", "overProbability", or any other model-decision field exists here for a caller to (even accidentally) feed back upstream (got ${keys.join(", ")})`,
  );
}

console.log(`\nmoundV2Executability.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
