// MLB odds provenance — Zod validation + reader-driven freshness — invariants.
//
// Run: npx tsx server/odds/mlbOddsProvenanceContract.test.ts

import { isMLBSnapshotFresh, type MlbGameStatus } from "../oddsService";
import {
  classifyMlbOddsFreshness,
  mlbOddsProvenanceSchema,
  buildMlbOddsProvenance,
} from "./mlbOddsProvenanceContract";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── Freshness classification cross-checked against isMLBSnapshotFresh ───────
// classifyMlbOddsFreshness must never disagree with the existing canonical
// boolean function on whether a snapshot counts as "fresh" — this is the
// regression guard against the two ever drifting apart.
{
  const statuses: MlbGameStatus[] = ["pregame", "live", "final", "unknown"];
  const ages = [0, 1_000, 29_000, 31_000, 119_000, 121_000, 10_000_000];
  for (const status of statuses) {
    for (const age of ages) {
      const freshness = classifyMlbOddsFreshness(status, age);
      const boolFresh = isMLBSnapshotFresh(status, age);
      if (status === "final") {
        ok(freshness === "immutable", `final @ ${age}ms classifies as immutable`);
        ok(boolFresh === true, `final @ ${age}ms is fresh per isMLBSnapshotFresh (sanity check)`);
      } else if (status === "unknown") {
        ok(freshness === "unknown", `unknown @ ${age}ms classifies as unknown`);
        ok(boolFresh === false, `unknown @ ${age}ms is never fresh per isMLBSnapshotFresh (sanity check)`);
      } else {
        ok((freshness === "fresh") === boolFresh,
          `${status} @ ${age}ms: classifyMlbOddsFreshness(fresh=${freshness === "fresh"}) agrees with isMLBSnapshotFresh(${boolFresh})`);
      }
    }
  }
}

// ── Zod schema ───────────────────────────────────────────────────────────
const validProvenance = {
  eventId: "evt1",
  playerId: "p1",
  market: "pitcher_strikeouts",
  side: "OVER",
  line: 5.5,
  americanOdds: -120,
  sportsbook: "draftkings",
  fetchedAt: "2026-07-29T22:00:00.000Z",
  sourceType: "sportsbook",
  context: "pregame",
  freshness: "fresh",
  expiresAt: null,
};
{
  ok(mlbOddsProvenanceSchema.safeParse(validProvenance).success, "a fully valid provenance object parses");
  ok(!mlbOddsProvenanceSchema.safeParse({ ...validProvenance, sportsbook: "odds_api" }).success,
    "'odds_api' is rejected as a sportsbook — not in the approved 3-book allowlist");
  ok(!mlbOddsProvenanceSchema.safeParse({ ...validProvenance, sportsbook: "" }).success, "empty sportsbook rejected");
  ok(!mlbOddsProvenanceSchema.safeParse({ ...validProvenance, americanOdds: 50 }).success,
    "american odds with magnitude < 100 rejected");
  ok(!mlbOddsProvenanceSchema.safeParse({ ...validProvenance, line: NaN }).success, "non-finite line rejected");
  ok(!mlbOddsProvenanceSchema.safeParse({ ...validProvenance, side: "PUSH" }).success, "invalid side literal rejected");
  ok(!mlbOddsProvenanceSchema.safeParse({ ...validProvenance, sourceType: "model" }).success,
    "sourceType other than 'sportsbook' rejected");
}

// ── buildMlbOddsProvenance: reader-driven freshness at build time ──────────
{
  const now = new Date("2026-07-29T22:05:00.000Z");
  const fresh = buildMlbOddsProvenance({
    eventId: "evt1", playerId: null, market: "home_runs", side: "OVER", line: 0.5,
    americanOdds: 250, sportsbook: "fanduel", fetchedAt: "2026-07-29T22:04:50.000Z", // 10s old
    context: "live", currentGameStatus: "live", now,
  });
  ok(fresh.freshness === "fresh", "10s-old live odds classify as fresh (30s live TTL)");

  const stale = buildMlbOddsProvenance({
    eventId: "evt1", playerId: null, market: "home_runs", side: "OVER", line: 0.5,
    americanOdds: 250, sportsbook: "fanduel", fetchedAt: "2026-07-29T22:04:00.000Z", // 60s old
    context: "live", currentGameStatus: "live", now,
  });
  ok(stale.freshness === "stale", "60s-old live odds classify as stale (>30s live TTL)");

  // Same fetchedAt/now (same age), different CURRENT game status -> different verdict.
  const sameAgePregame = buildMlbOddsProvenance({
    eventId: "evt1", playerId: null, market: "home_runs", side: "OVER", line: 0.5,
    americanOdds: 250, sportsbook: "fanduel", fetchedAt: "2026-07-29T22:04:00.000Z", // 60s old
    context: "pregame", currentGameStatus: "pregame", now,
  });
  ok(sameAgePregame.freshness === "fresh", "the SAME 60s-old odds classify as fresh once the reader's current game state is pregame (2min TTL)");
}

console.log(`\nmlbOddsProvenanceContract.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
