// shared/hrRadarBestContacts — selectBestContacts() invariants.
// Run: npx tsx shared/hrRadarBestContacts.test.ts
//
// Pure selection over already-computed HR Radar scores: Attack+Ready-only
// eligibility, score-desc ordering with tier tiebreak, deterministic name
// tiebreak, and limit slicing.

import { selectBestContacts, type BestContactCandidate } from "./hrRadarBestContacts";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function candidate(overrides: Partial<BestContactCandidate>): BestContactCandidate {
  return {
    playerId: "p1",
    gameId: "g1",
    playerName: "Player",
    team: "NYY",
    userStage: "fire",
    currentReadinessScore: 80,
    confidenceTier: "ELITE",
    ...overrides,
  };
}

// ── Eligibility: only fire/ready pass, everything else excluded ────────────
{
  const candidates = [
    candidate({ playerId: "a", userStage: "fire" }),
    candidate({ playerId: "b", userStage: "ready" }),
    candidate({ playerId: "c", userStage: "build" }),
    candidate({ playerId: "d", userStage: "track" }),
    candidate({ playerId: "e", userStage: "resolved" }),
    candidate({ playerId: "f", userStage: null }),
    candidate({ playerId: "g", userStage: "cashed" }),
  ];
  const result = selectBestContacts(candidates, 10);
  ok(result.length === 2, "eligibility: only fire+ready survive the filter");
  ok(result.every((r) => r.playerId === "a" || r.playerId === "b"), "eligibility: exact ids a,b survive");
}

// ── Score-desc ordering ──────────────────────────────────────────────────
{
  const candidates = [
    candidate({ playerId: "low", currentReadinessScore: 55 }),
    candidate({ playerId: "high", currentReadinessScore: 92 }),
    candidate({ playerId: "mid", currentReadinessScore: 70 }),
  ];
  const result = selectBestContacts(candidates, 10);
  ok(result.map((r) => r.playerId).join(",") === "high,mid,low", "ordering: sorted by score desc");
}

// ── Tier tiebreak when scores are equal ─────────────────────────────────
{
  const candidates = [
    candidate({ playerId: "solid", currentReadinessScore: 65, confidenceTier: "SOLID" }),
    candidate({ playerId: "elite", currentReadinessScore: 65, confidenceTier: "ELITE" }),
    candidate({ playerId: "strong", currentReadinessScore: 65, confidenceTier: "STRONG" }),
  ];
  const result = selectBestContacts(candidates, 10);
  ok(result.map((r) => r.playerId).join(",") === "elite,strong,solid", "tiebreak: equal score falls back to tier rank");
}

// ── Name tiebreak for full determinism ───────────────────────────────────
{
  const candidates = [
    candidate({ playerId: "z", playerName: "Zeb", currentReadinessScore: 70, confidenceTier: "STRONG" }),
    candidate({ playerId: "a", playerName: "Aaron", currentReadinessScore: 70, confidenceTier: "STRONG" }),
  ];
  const result = selectBestContacts(candidates, 10);
  ok(result.map((r) => r.playerId).join(",") === "a,z", "tiebreak: equal score+tier falls back to name asc");
}

// ── Empty input ───────────────────────────────────────────────────────────
ok(selectBestContacts([], 5).length === 0, "empty input returns []");

// ── limit respected, and fewer-than-limit eligible returns all of them ───
{
  const candidates = Array.from({ length: 8 }, (_, i) =>
    candidate({ playerId: `p${i}`, currentReadinessScore: 100 - i }),
  );
  ok(selectBestContacts(candidates, 5).length === 5, "limit: slices to N");
  ok(selectBestContacts(candidates, 3)[0].playerId === "p0", "limit: keeps the highest scores");

  const onlyTwo = [
    candidate({ playerId: "x", currentReadinessScore: 90 }),
    candidate({ playerId: "y", currentReadinessScore: 80 }),
  ];
  ok(selectBestContacts(onlyTwo, 5).length === 2, "limit: fewer-than-limit eligible returns all of them");
}

console.log(`\nhrRadarBestContacts.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
