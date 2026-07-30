// Mound V2 per-batter strikeout probability blend — invariants.
//
// Run: npx tsx server/mlb/pregame/mound/v2/batterStrikeoutProbability.test.ts

import { computeBatterStrikeoutProbability, LEAGUE_K_RATE } from "./batterStrikeoutProbability";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── Both inputs missing degrades to the league rate ─────────────────────────
{
  const p = computeBatterStrikeoutProbability(null, null);
  ok(p === LEAGUE_K_RATE, `both-missing degrades to the league K rate (got ${p})`);
}

// ── One-sided degradation ────────────────────────────────────────────────────
{
  const p = computeBatterStrikeoutProbability(0.3, null);
  ok(Math.abs(p - 0.3) < 1e-9, `pitcher-only input passes through unchanged (got ${p})`);
  const p2 = computeBatterStrikeoutProbability(null, 0.28);
  ok(Math.abs(p2 - 0.28) < 1e-9, `batter-only input passes through unchanged (got ${p2})`);
}

// ── Both present: a high-K pitcher facing a high-K batter compounds above either alone ──
{
  const pitcherOnly = computeBatterStrikeoutProbability(0.32, null);
  const batterOnly = computeBatterStrikeoutProbability(null, 0.30);
  const both = computeBatterStrikeoutProbability(0.32, 0.30);
  ok(both > LEAGUE_K_RATE, "an elite-K pitcher vs. a strikeout-prone batter blends to well above league average");
  ok(both < Math.max(pitcherOnly, batterOnly) + 0.05, "the blend does not runaway past a sane bound above either one-sided read");
}

// ── A contact-heavy batter pulls an elite-K pitcher back toward neutral ────
{
  const elitePitcherAlone = computeBatterStrikeoutProbability(0.34, null);
  const blended = computeBatterStrikeoutProbability(0.34, 0.12);
  ok(blended < elitePitcherAlone, "a low-K contact batter pulls the blended probability below the pitcher-alone read");
  ok(blended > 0.12, "the blend does not collapse all the way to the batter's own extreme rate — the pitcher side still contributes");
}

// ── Output is always a valid probability ────────────────────────────────────
{
  const extremeHigh = computeBatterStrikeoutProbability(0.9, 0.9);
  const extremeLow = computeBatterStrikeoutProbability(0.01, 0.01);
  ok(extremeHigh > 0 && extremeHigh < 1, `extreme-high inputs still clamp to a valid probability (got ${extremeHigh})`);
  ok(extremeLow > 0 && extremeLow < 1, `extreme-low inputs still clamp to a valid probability (got ${extremeLow})`);
}

console.log(`\nbatterStrikeoutProbability.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
