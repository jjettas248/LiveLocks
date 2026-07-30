// Mound V2 (shadow) — EXECUTABILITY invariants (Mound V2 purity pass; Final
// Line-Provenance and V1 Purity Correction). The counterpart to
// moundV2ModelPolicy.test.ts: proves this module answers a completely
// separate, downstream question — never influences the model's own
// side/qualification, and has no mechanism to write back into it. Also
// proves the ATOMIC OFFER contract: market/side/sportsbook/line/price/
// fetchedAt are always stamped together, non-null if and only if
// executable is true — never a half-populated offer.
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
    market: "pitcher_strikeouts",
    side: "OVER",
    line: 6.5,
    overPrice: -120,
    underPrice: 100,
    sportsbook: "draftkings",
    oddsFetchedAt: "2026-07-30T19:58:00.000Z", // 2 minutes before `now`
    now: NOW,
    ...over,
  };
}

// ── A fresh, fully-provenanced price is executable, with a real atomic offer ──
{
  const result = applyMoundV2Executability(MOUND_V2_DEFAULT_EXECUTABILITY_POLICY, input());
  ok(result.executable === true && result.failureReason === null, "a fresh price with full provenance is executable, with no failure reason");
  ok(result.offer !== null, "a non-null atomic offer is produced");
  ok(
    result.offer?.market === "pitcher_strikeouts" && result.offer?.side === "OVER" && result.offer?.sportsbook === "draftkings" &&
    result.offer?.line === 6.5 && result.offer?.price === -120 && result.offer?.fetchedAt === "2026-07-30T19:58:00.000Z",
    "the atomic offer's market/side/sportsbook/line/price/fetchedAt are all exactly the real captured values",
  );
  ok(result.policyVersion === MOUND_V2_DEFAULT_EXECUTABILITY_POLICY.policyVersion, "the result carries the real policy version it was evaluated under");
}

// ── side reads the correct price: OVER reads overPrice, UNDER reads underPrice — never crossed ──
{
  const overResult = applyMoundV2Executability(MOUND_V2_DEFAULT_EXECUTABILITY_POLICY, input({ side: "OVER", overPrice: -150, underPrice: 130 }));
  ok(overResult.offer?.price === -150, `side=OVER reads overPrice, never underPrice (got ${overResult.offer?.price})`);
  ok(overResult.offer?.side === "OVER", "the offer's own side field matches the side that was actually priced");

  const underResult = applyMoundV2Executability(MOUND_V2_DEFAULT_EXECUTABILITY_POLICY, input({ side: "UNDER", overPrice: -150, underPrice: 130 }));
  ok(underResult.offer?.price === 130, `side=UNDER reads underPrice, never overPrice (got ${underResult.offer?.price})`);
  ok(underResult.offer?.side === "UNDER", "the offer's own side field matches the side that was actually priced");
}

// ── side: null (model abstained) -> not_applicable, regardless of price ────
{
  const result = applyMoundV2Executability(MOUND_V2_DEFAULT_EXECUTABILITY_POLICY, input({ side: null }));
  ok(result.executable === false && result.failureReason === "not_applicable", "a null side (model abstained) is honestly not_applicable — executability was never a live question here");
  ok(result.offer === null, "not_applicable produces no offer at all — never a partial one");
}

// ── Missing line -> missing_line (no real market was ever posted) ─────────
{
  const result = applyMoundV2Executability(MOUND_V2_DEFAULT_EXECUTABILITY_POLICY, input({ line: null }));
  ok(result.executable === false && result.failureReason === "missing_line", "a null line is honestly missing_line — distinct from missing_price, since no market existed at all");
  ok(result.offer === null, "missing_line produces no offer");
}

// ── Missing price -> missing_price ──────────────────────────────────────────
{
  const result = applyMoundV2Executability(MOUND_V2_DEFAULT_EXECUTABILITY_POLICY, input({ overPrice: null }));
  ok(result.executable === false && result.failureReason === "missing_price", "a null price for the model's own side is honestly missing_price, never fabricated");
  ok(result.offer === null, "missing_price produces no offer — never a partial one exposing whatever sportsbook/timestamp happened to be available");
}

// ── Missing provenance -> missing_provenance ────────────────────────────────
{
  const noBook = applyMoundV2Executability(MOUND_V2_DEFAULT_EXECUTABILITY_POLICY, input({ sportsbook: null }));
  ok(noBook.executable === false && noBook.failureReason === "missing_provenance" && noBook.offer === null, "a null sportsbook is missing_provenance, with no offer");

  const noTimestamp = applyMoundV2Executability(MOUND_V2_DEFAULT_EXECUTABILITY_POLICY, input({ oddsFetchedAt: null }));
  ok(noTimestamp.executable === false && noTimestamp.failureReason === "missing_provenance" && noTimestamp.offer === null, "a null fetch timestamp is ALSO missing_provenance, with no offer");
}

// ── Stale odds -> odds_too_stale ─────────────────────────────────────────────
{
  const staleResult = applyMoundV2Executability(MOUND_V2_DEFAULT_EXECUTABILITY_POLICY, input({ oddsFetchedAt: "2026-07-28T00:00:00.000Z" })); // ~44h before now
  ok(staleResult.executable === false && staleResult.failureReason === "odds_too_stale", "a price far older than maximumOddsAgeMs is odds_too_stale");
  ok(staleResult.offer === null, "odds_too_stale produces no offer — a stale price is never captured as if it were executable");
}

// ── Boundary: exactly at the max age is still executable (>, not >=) ───────
{
  const exactBoundary = new Date(NOW.getTime() - MOUND_V2_DEFAULT_EXECUTABILITY_POLICY.maximumOddsAgeMs);
  const result = applyMoundV2Executability(MOUND_V2_DEFAULT_EXECUTABILITY_POLICY, input({ oddsFetchedAt: exactBoundary.toISOString() }));
  ok(result.executable === true && result.offer !== null, "a price exactly at the max age boundary is still executable (the staleness check is strictly >, never >=)");

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
  ok(result?.executable === false && result?.failureReason === "odds_too_stale" && result?.offer === null, "a malformed timestamp produces a NaN age, which safely fails closed as stale (no offer) rather than crashing or defaulting to executable");
}

// ── Atomicity: market/side/sportsbook/line/price/fetchedAt are ALWAYS stamped together from ONE source — never independently mismatched ──
{
  // Vary EVERY field across many calls and confirm the offer's own fields
  // always echo exactly what was fed in for THAT call — never a stale
  // value from a previous call, never a cross-wired field.
  const scenarios: Array<{ market: "pitcher_strikeouts" | "pitcher_outs"; side: "OVER" | "UNDER"; sportsbook: string; line: number; price: number; fetchedAt: string }> = [
    { market: "pitcher_strikeouts", side: "OVER", sportsbook: "draftkings", line: 6.5, price: -120, fetchedAt: "2026-07-30T19:58:00.000Z" },
    { market: "pitcher_outs", side: "UNDER", sportsbook: "fanduel", line: 17.5, price: 105, fetchedAt: "2026-07-30T19:59:00.000Z" },
    { market: "pitcher_strikeouts", side: "UNDER", sportsbook: "hardrockbet", line: 7.5, price: -108, fetchedAt: "2026-07-30T19:57:30.000Z" },
  ];
  for (const s of scenarios) {
    const result = applyMoundV2Executability(MOUND_V2_DEFAULT_EXECUTABILITY_POLICY, input({
      market: s.market, side: s.side, line: s.line, sportsbook: s.sportsbook, oddsFetchedAt: s.fetchedAt,
      overPrice: s.side === "OVER" ? s.price : null,
      underPrice: s.side === "UNDER" ? s.price : null,
    }));
    ok(
      result.offer?.market === s.market && result.offer?.side === s.side && result.offer?.sportsbook === s.sportsbook &&
      result.offer?.line === s.line && result.offer?.price === s.price && result.offer?.fetchedAt === s.fetchedAt,
      `offer for ${s.market}/${s.side}/${s.sportsbook} carries exactly this scenario's own line/price/timestamp, never a value from a different scenario (got ${JSON.stringify(result.offer)})`,
    );
  }
}

// ── One-way data flow: executability's result shape has no field that could write back into a model decision ──
{
  const result = applyMoundV2Executability(MOUND_V2_DEFAULT_EXECUTABILITY_POLICY, input());
  const keys = Object.keys(result).sort();
  ok(
    JSON.stringify(keys) === JSON.stringify(["executable", "failureReason", "offer", "policyVersion"].sort()),
    `MoundV2ExecutabilityResult has exactly these keys — no "modelQualified", "overProbability", or any other model-decision field exists here for a caller to (even accidentally) feed back upstream (got ${keys.join(", ")})`,
  );
  const offerKeys = Object.keys(result.offer!).sort();
  ok(
    JSON.stringify(offerKeys) === JSON.stringify(["fetchedAt", "line", "market", "price", "side", "sportsbook"].sort()),
    `the atomic offer itself has exactly these 6 keys — no "modelQualified" or probability field could leak in here either (got ${offerKeys.join(", ")})`,
  );
}

console.log(`\nmoundV2Executability.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
