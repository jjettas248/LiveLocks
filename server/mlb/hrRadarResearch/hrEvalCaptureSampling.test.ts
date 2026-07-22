// HR Radar research capture sampling — determinism, monotonicity, fail-closed
// boundaries.
//
// Run: npx tsx server/mlb/hrRadarResearch/hrEvalCaptureSampling.test.ts

import { shouldSampleGameForHrEvalCapture } from "./hrEvalCaptureSampling";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const GAME_IDS = Array.from({ length: 200 }, (_, i) => `game-${i}`);

// Determinism — same gameId + percent always returns the same result.
for (const gameId of GAME_IDS.slice(0, 20)) {
  const a = shouldSampleGameForHrEvalCapture(gameId, 37);
  const b = shouldSampleGameForHrEvalCapture(gameId, 37);
  ok(a === b, `shouldSampleGameForHrEvalCapture(${gameId}, 37) is deterministic across repeated calls`);
}

// Fail-closed boundaries.
for (const gameId of GAME_IDS.slice(0, 20)) {
  ok(shouldSampleGameForHrEvalCapture(gameId, 0) === false, `percent<=0 is always false for ${gameId}`);
  ok(shouldSampleGameForHrEvalCapture(gameId, -5) === false, `negative percent is always false for ${gameId}`);
  ok(shouldSampleGameForHrEvalCapture(gameId, 100) === true, `percent>=100 is always true for ${gameId}`);
  ok(shouldSampleGameForHrEvalCapture(gameId, 150) === true, `percent>100 is always true for ${gameId}`);
}
ok(shouldSampleGameForHrEvalCapture("gameNaN", Number.NaN) === false, "NaN percent fails closed to false");

// Monotonicity — raising the percent only ADDS games, never removes a
// previously-sampled one.
{
  const at10 = new Set(GAME_IDS.filter((g) => shouldSampleGameForHrEvalCapture(g, 10)));
  const at50 = new Set(GAME_IDS.filter((g) => shouldSampleGameForHrEvalCapture(g, 50)));
  const at90 = new Set(GAME_IDS.filter((g) => shouldSampleGameForHrEvalCapture(g, 90)));

  let monotonic1050 = true;
  for (const g of Array.from(at10)) if (!at50.has(g)) monotonic1050 = false;
  ok(monotonic1050, "every game sampled at 10% is still sampled at 50%");

  let monotonic5090 = true;
  for (const g of Array.from(at50)) if (!at90.has(g)) monotonic5090 = false;
  ok(monotonic5090, "every game sampled at 50% is still sampled at 90%");

  // Roughly proportional bucket sizes over 200 games (loose bounds — this is
  // a hash-bucket sanity check, not a statistical precision test).
  ok(at10.size < at50.size, "10% bucket is strictly smaller than the 50% bucket over 200 games");
  ok(at50.size < at90.size, "50% bucket is strictly smaller than the 90% bucket over 200 games");
}

console.log(`hrEvalCaptureSampling.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
