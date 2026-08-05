// Mound Radar — baseline win/loss historical backfill planner invariants.
// Run: npx tsx server/mlb/pregame/mound/moundBaselineOutcomeBackfill.test.ts

import { planMoundBaselineOutcomeBackfill, type MoundBaselineOutcomeBackfillRow } from "./moundBaselineOutcomeBackfill";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function row(over: Partial<MoundBaselineOutcomeBackfillRow> = {}): MoundBaselineOutcomeBackfillRow {
  return {
    signalId: "mlb-mound:2026-07-01:g1:p1",
    primaryMarket: "pitcher_outs",
    finalStrikeouts: 8,
    frozenBaselineStrikeouts: 6.0,
    settledDirection: "follow",
    wasPubliclyFlagged: true,
    ...over,
  };
}

// ── A row already graded on strikeouts is skipped — nothing to fix ──────────
{
  const plan = planMoundBaselineOutcomeBackfill([row({ primaryMarket: "pitcher_strikeouts" })]);
  ok(plan.length === 0, "primaryMarket already pitcher_strikeouts → skipped, already correct");
}

// ── Follow: an Outs-Best-Angle row that cleared the K baseline recomputes as a public win ──
{
  const plan = planMoundBaselineOutcomeBackfill([row({ finalStrikeouts: 8, frozenBaselineStrikeouts: 6.0, settledDirection: "follow", wasPubliclyFlagged: true })]);
  ok(plan.length === 1, "resolvable Outs-Best-Angle row is included in the plan");
  ok(plan[0].patch.outcome === "mound_win", "8 Ks clears a 6.0 baseline under Follow → mound_win");
  ok(plan[0].patch.userVisible === true, "publicly flagged win → userVisible");
  ok(plan[0].patch.seasonBaselineValue === 6.0, "seasonBaselineValue is the frozen K baseline, not an outs number");
}

// ── Follow: missed the K baseline → calibration_miss, never userVisible ─────
{
  const plan = planMoundBaselineOutcomeBackfill([row({ finalStrikeouts: 4, frozenBaselineStrikeouts: 6.0, settledDirection: "follow", wasPubliclyFlagged: true })]);
  ok(plan[0].patch.outcome === "mound_calibration_miss", "4 Ks misses a 6.0 baseline under Follow → calibration_miss");
  ok(plan[0].patch.userVisible === false, "calibration miss is never userVisible");
}

// ── Fade: undershooting the K baseline recomputes as a public fade win ──────
{
  const plan = planMoundBaselineOutcomeBackfill([row({ finalStrikeouts: 4, frozenBaselineStrikeouts: 6.0, settledDirection: "fade", wasPubliclyFlagged: true })]);
  ok(plan[0].patch.outcome === "mound_fade_win", "4 Ks under a 6.0 baseline under Fade → mound_fade_win");
  ok(plan[0].patch.userVisible === true, "publicly flagged fade win → userVisible");
}

// ── Fade: the fade call was wrong (met/beat baseline) → calibration_miss, never a public loss ──
{
  const plan = planMoundBaselineOutcomeBackfill([row({ finalStrikeouts: 8, frozenBaselineStrikeouts: 6.0, settledDirection: "fade", wasPubliclyFlagged: true })]);
  ok(plan[0].patch.outcome === "mound_calibration_miss", "8 Ks over a 6.0 baseline under Fade (wrong fade call) → calibration_miss, never mound_fade_win");
}

// ── A win that clears the bar but was never publicly flagged recomputes as an internal win ──
{
  const plan = planMoundBaselineOutcomeBackfill([row({ finalStrikeouts: 8, frozenBaselineStrikeouts: 6.0, settledDirection: "follow", wasPubliclyFlagged: false })]);
  ok(plan[0].patch.outcome === "mound_win", "cleared the baseline but unflagged → still mound_win");
  ok(plan[0].patch.userVisible === false, "unflagged win is never public");
}

// ── Missing frozen baseline or final K count → left untouched, never fabricated ──
{
  const noBaseline = planMoundBaselineOutcomeBackfill([row({ frozenBaselineStrikeouts: null })]);
  ok(noBaseline.length === 0, "no frozen K baseline captured → nothing provable, row left untouched");

  const noFinal = planMoundBaselineOutcomeBackfill([row({ finalStrikeouts: null })]);
  ok(noFinal.length === 0, "no final K count captured → nothing provable, row left untouched");
}

// ── Idempotent: re-running on the same stored data produces the same patch ──
{
  const input = [row({ finalStrikeouts: 8, frozenBaselineStrikeouts: 6.0, settledDirection: "follow", wasPubliclyFlagged: true })];
  const first = planMoundBaselineOutcomeBackfill(input);
  const second = planMoundBaselineOutcomeBackfill(input);
  ok(JSON.stringify(first) === JSON.stringify(second), "re-running the planner on identical input yields an identical plan — safe to re-run");
}

console.log(`\nmoundBaselineOutcomeBackfill.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
