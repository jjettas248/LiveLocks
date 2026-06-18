// Consolidated HR overlay invariants.
// Run with: npx tsx server/mlb/hr/__tests__/hrOverlay.test.ts

import { computeHROverlay } from "../hrOverlay";
import type { HROverlayInput } from "../hrOverlayTypes";
import { applySeasonTriadWeighting } from "../temporalFilter";
import { ratioToScore, ratioVsBaseline } from "../normalization";
import {
  OVERLAY_MULTIPLIER_MIN,
  OVERLAY_MULTIPLIER_MAX,
  GATE_SOFT_FLOOR,
} from "../hrOverlayConstants";

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function close(a: number, b: number, eps: number) { return Math.abs(a - b) <= eps; }

console.log("\n[HR overlay] running cases\n");

// ── No-op: absent inputs → neutral multiplier ────────────────────────────────
{
  const r = computeHROverlay({});
  assert("Empty input → overlayMultiplier == 1.0", r.overlayMultiplier === 1.0, `mult=${r.overlayMultiplier}`);
  assert("Empty input → omega == 0", r.omega === 0, `omega=${r.omega}`);
  assert("Empty input → soft gate neutral", r.softGateFactor === 1.0, `gate=${r.softGateFactor}`);
  assert("Empty input → no confidence penalty", r.confidencePenalty === false);
  assert("Empty input → all coverage MISSING",
    Object.values(r.dataCoverage).every((c) => c === "MISSING"),
    JSON.stringify(r.dataCoverage));
}

// ── Strong power profile lifts the multiplier above 1.0 ──────────────────────
{
  const strong = computeHROverlay({
    barrelPerPA: 0.110, exitVelocity: 93, sweetSpotPct: 40, xwOBAcon: 0.460,
  });
  assert("Elite power → multiplier > 1.0", strong.overlayMultiplier > 1.0, `mult=${strong.overlayMultiplier}`);
  assert("Elite power → STRONG_STATCAST_POWER reason", strong.reasons.includes("STRONG_STATCAST_POWER"));
  assert("Elite power → statcastBatting coverage FULL", strong.dataCoverage.statcastBatting === "FULL");
}

// ── Temporal filter: 2023 and older rows are excluded ────────────────────────
{
  const triad = applySeasonTriadWeighting([
    { season: 2023, value: 999, pa: 600 },   // must be rejected
    { season: 2026, value: 0.10, pa: 300 },
    { season: 2025, value: 0.08, pa: 400 },
  ]);
  assert("2023 row rejected by triad filter", triad.rejectedSeasons.includes(2023),
    `rejected=${JSON.stringify(triad.rejectedSeasons)}`);
  assert("Triad only uses allowed seasons", triad.seasonsUsed.every((s) => s === 2026 || s === 2025),
    `used=${JSON.stringify(triad.seasonsUsed)}`);
  // 2026 weighted heavier than 2025: blend skews toward 0.10.
  const expected = (0.50 / 0.85) * 0.10 + (0.35 / 0.85) * 0.08;
  assert("Triad blend recency-weights 2026 over 2025", close(triad.value ?? 0, expected, 1e-6),
    `value=${triad.value} expected=${expected}`);

  const dirtyOnly = applySeasonTriadWeighting([{ season: 2019, value: 0.30, pa: 700 }]);
  assert("Only-stale rows → null blended value", dirtyOnly.value === null, `value=${dirtyOnly.value}`);
}

// ── Low 2024–2026 sample → risk + confidence penalty ─────────────────────────
{
  const thin = computeHROverlay({ barrelPerPA: 0.09, totalPA2024to2026: 40 });
  assert("Thin sample → LOW_2024_2026_SAMPLE risk", thin.risks.includes("LOW_2024_2026_SAMPLE"));
  assert("Thin sample → confidence penalty", thin.confidencePenalty === true);
}

// ── Recent-OPS-alone cannot originate a bettable signal ──────────────────────
{
  const opsOnly = computeHROverlay({ recentOps: 1.40, seasonOps: 0.70 });
  // recency weight 0.12, OPS is only 20% of recency → tiny push, no power/launch.
  assert("OPS-alone → multiplier stays modest (< 1.10)", opsOnly.overlayMultiplier < 1.10,
    `mult=${opsOnly.overlayMultiplier}`);
  assert("OPS-alone → no power/launch/arsenal reasons",
    !opsOnly.reasons.some((r) => ["STRONG_STATCAST_POWER", "PULL_AIR_POWER_SHAPE", "ARSENAL_DAMAGE_MATCH"].includes(r)),
    JSON.stringify(opsOnly.reasons));
}

// ── Park/weather are NOT overlay inputs → cannot move the overlay at all ──────
{
  // The overlay has no park/weather fields by design (those stay in the engine
  // environment multiplier). Confirm a power-less input can't be pushed by them.
  const none = computeHROverlay({ recentSlg: 0.500, seasonSlg: 0.500 });
  assert("Neutral recency + no power → multiplier ≈ 1.0", close(none.overlayMultiplier, 1.0, 0.01),
    `mult=${none.overlayMultiplier}`);
}

// ── Soft gate dampens but never zeroes; stamps penalty ───────────────────────
{
  const dead = computeHROverlay({
    barrelPerPA: 0.010, maxEV: 98, toppedPct: 40, exitVelocity: 84,
  });
  assert("Below contact floors → soft gate < 1.0", dead.softGateFactor < 1.0, `gate=${dead.softGateFactor}`);
  assert("Soft gate never below floor", dead.softGateFactor >= GATE_SOFT_FLOOR, `gate=${dead.softGateFactor}`);
  assert("Soft gate → overlay multiplier > 0 (not a hard kill)", dead.overlayMultiplier > 0,
    `mult=${dead.overlayMultiplier}`);
  assert("Soft gate → confidence penalty", dead.confidencePenalty === true);
  assert("Soft gate → GROUND_BALL_SUPPRESSION risk", dead.risks.includes("GROUND_BALL_SUPPRESSION"));
}

// ── Γ arsenal-matchup is no-op (MISSING) without pitch-type splits ───────────
{
  const noSplits = computeHROverlay({
    pitchMix: [{ pitchType: "FF", percentage: 60, avgVelocity: 95 }],
    barrelPerPA: 0.09,
  });
  assert("No batter pitch splits → matchup MISSING", noSplits.dataCoverage.pitchTracking === "MISSING");
  assert("No batter pitch splits → matchup score 0", noSplits.components.matchup.score === 0,
    `score=${noSplits.components.matchup.score}`);
  assert("No batter pitch splits → PITCH_TRACKING_MISSING risk", noSplits.risks.includes("PITCH_TRACKING_MISSING"));

  // With splits + usage, a fastball-damaging hitter vs a fastball-heavy pitcher fires.
  const withSplits = computeHROverlay({
    pitchMix: [{ pitchType: "FF", percentage: 65, avgVelocity: 95 }, { pitchType: "SL", percentage: 35, avgVelocity: 86 }],
    batterPitchSplits: [
      { family: "fastball", xSlg: 0.620, whiffPct: 16 },
      { family: "breaking", xSlg: 0.300, whiffPct: 38 },
    ],
  });
  assert("Damaging fastball matchup → positive matchup score", withSplits.components.matchup.score > 0,
    `score=${withSplits.components.matchup.score}`);
  assert("Damaging fastball matchup → ARSENAL_DAMAGE_MATCH reason", withSplits.reasons.includes("ARSENAL_DAMAGE_MATCH"));
}

// ── Batting-order split unavailable → lineup PARTIAL (volume still scores) ────
{
  const slotOnly = computeHROverlay({ battingOrderSlot: 3 });
  assert("Slot present, no split → lineup PARTIAL", slotOnly.components.lineup.coverage === "PARTIAL",
    `coverage=${slotOnly.components.lineup.coverage}`);
  assert("Slot present → BATTING_ORDER_SPLIT_UNAVAILABLE risk", slotOnly.risks.includes("BATTING_ORDER_SPLIT_UNAVAILABLE"));
}

// ── Winsorization caps one extreme stat ──────────────────────────────────────
{
  const r = ratioVsBaseline(100, 1); // ratio 100 → winsorized to 2.0
  assert("Extreme ratio winsorized to 2.0", r === 2.0, `ratio=${r}`);
  assert("ratioToScore(2.0) == +1 (clamped)", ratioToScore(2.0) === 1, `score=${ratioToScore(2.0)}`);
  assert("ratioToScore(1.0) == 0 (neutral)", ratioToScore(1.0) === 0, `score=${ratioToScore(1.0)}`);
}

// ── Multiplier always respects the clamp envelope ────────────────────────────
{
  const maxed = computeHROverlay({
    barrelPerPA: 0.30, exitVelocity: 120, sweetSpotPct: 80, xwOBAcon: 0.90,
    flyBallPct: 70, pullAirPct: 90, battingOrderSlot: 3,
    recentSlg: 1.5, seasonSlg: 0.4, recentOps: 1.6, seasonOps: 0.6,
    hrRateLast7: 0.20, hrRateLast15: 0.18, seasonHRRate: 0.03,
    pitchMix: [{ pitchType: "FF", percentage: 80, avgVelocity: 95 }],
    batterPitchSplits: [{ family: "fastball", xSlg: 0.900, whiffPct: 5 }],
  });
  assert("Maxed input respects upper clamp", maxed.overlayMultiplier <= OVERLAY_MULTIPLIER_MAX,
    `mult=${maxed.overlayMultiplier}`);
  assert("Maxed input respects lower clamp", maxed.overlayMultiplier >= OVERLAY_MULTIPLIER_MIN,
    `mult=${maxed.overlayMultiplier}`);
}

console.log(`\n[HR overlay] ${passed}/${passed + failed} cases passed${failed > 0 ? ` (${failed} FAILED)` : ""}\n`);
if (failed > 0) process.exit(1);
