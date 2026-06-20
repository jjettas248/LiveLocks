// Phase 2 ingestion — pure aggregation + Γ arsenal-matchup invariants.
// Run with: npx tsx server/mlb/phase2Ingestion.test.ts

import { aggregateBatterPitchAndContact, mergePitchUsage } from "./dataSources";
import { aggregateOrderSplits, slgForSlot, type OrderSplitRow } from "./orderSplits";
import { computeArsenalMatchupFit } from "./hr/subEngines";

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

type Row = Record<string, string>;
function rep(n: number, row: Row): Row[] {
  return Array.from({ length: n }, () => ({ ...row }));
}

console.log("\n[Phase 2 ingestion] running cases\n");

// ── aggregateBatterPitchAndContact ──────────────────────────────────────────
{
  const empty = aggregateBatterPitchAndContact([]);
  assert("Empty rows → no splits", empty.batterPitchSplits === null);
  assert("Empty rows → toppedPct null", empty.toppedPct === null);
  assert("Empty rows → maxEV null", empty.maxEV === null);
}

{
  const fbBIP = rep(8, {
    pitch_type: "FF", description: "hit_into_play", bb_type: "line_drive",
    launch_speed: "104", estimated_slg_using_speedangle: "1.200", launch_speed_angle: "6",
  });
  const fbWhiff = rep(2, { pitch_type: "FF", description: "swinging_strike" });
  const brkTopped = rep(8, {
    pitch_type: "SL", description: "hit_into_play", bb_type: "ground_ball",
    launch_speed: "78", estimated_slg_using_speedangle: "0.100", launch_speed_angle: "2",
  });
  const brkOther = rep(12, {
    pitch_type: "SL", description: "hit_into_play", bb_type: "ground_ball",
    launch_speed: "82", estimated_slg_using_speedangle: "0.150", launch_speed_angle: "3",
  });
  const agg = aggregateBatterPitchAndContact([...fbBIP, ...fbWhiff, ...brkTopped, ...brkOther]);
  const fam = (f: string) => agg.batterPitchSplits?.find((s) => s.pitchType === f);

  assert("Fastball split present", fam("fastball") != null);
  assert("Fastball xSLG ≈ 1.20", Math.abs((fam("fastball")?.xSLG ?? 0) - 1.2) < 1e-6, `xSLG=${fam("fastball")?.xSLG}`);
  assert("Fastball whiff% == 20 (2 of 10 swings)", fam("fastball")?.whiffPct === 20, `whiff=${fam("fastball")?.whiffPct}`);
  assert("Breaking xSLG low (~0.13)", (fam("breaking")?.xSLG ?? 1) < 0.2, `xSLG=${fam("breaking")?.xSLG}`);
  assert("maxEV == 104", agg.maxEV === 104, `maxEV=${agg.maxEV}`);
  assert("toppedPct computed (~28.6)", agg.toppedPct != null && Math.abs(agg.toppedPct - 28.6) < 0.2, `topped=${agg.toppedPct}`);
}

{
  const few = rep(5, { pitch_type: "CH", description: "swinging_strike" });
  const agg = aggregateBatterPitchAndContact(few);
  const off = agg.batterPitchSplits?.find((s) => s.pitchType === "offspeed");
  assert("Thin offspeed sample → no published split", off == null, `off=${JSON.stringify(off)}`);
}

{
  const noLsa = rep(30, {
    pitch_type: "FF", description: "hit_into_play", bb_type: "fly_ball",
    launch_speed: "95", estimated_slg_using_speedangle: "0.500",
  });
  const agg = aggregateBatterPitchAndContact(noLsa);
  assert("No launch_speed_angle column → toppedPct null", agg.toppedPct === null, `topped=${agg.toppedPct}`);
}

// ── mergePitchUsage ─────────────────────────────────────────────────────────
{
  const splits = [
    { pitchType: "fastball" as const, xSLG: 0.6, whiffPct: 18 },
    { pitchType: "breaking" as const, xSLG: 0.3, whiffPct: 35 },
  ];
  const mix = [
    { pitchType: "FF", percentage: 60, avgVelocity: 95 },
    { pitchType: "SL", percentage: 40, avgVelocity: 86 },
  ];
  const merged = mergePitchUsage(splits, mix);
  const fb = merged?.find((s) => s.pitchType === "fastball");
  assert("Fastball usagePct == 60 from pitch mix", fb?.usagePct === 60, `usage=${fb?.usagePct}`);
  assert("No pitch mix → splits unchanged", mergePitchUsage(splits, null) === splits);
  assert("No splits → null", mergePitchUsage(null, mix) === null);
}

// ── Γ arsenal matchup scoring ───────────────────────────────────────────────
{
  // Damaging fastballs vs a fastball-heavy pitcher → positive Γ.
  const hot = computeArsenalMatchupFit({
    pitchTypeSplits: [
      { pitchType: "fastball", xSLG: 0.650, whiffPct: 15, usagePct: 65 },
      { pitchType: "breaking", xSLG: 0.300, whiffPct: 38, usagePct: 35 },
    ],
  });
  assert("Damaging fastball matchup → positive Γ score", hot.score > 0, `score=${hot.score}`);
  assert("Damaging fastball matchup → ARSENAL_DAMAGE_MATCH reason", hot.reasons.includes("ARSENAL_DAMAGE_MATCH"));
  assert("Γ coverage FULL with usage", hot.coverage === "FULL", `cov=${hot.coverage}`);

  // No splits → MISSING / 0 (overlay weight inert).
  const none = computeArsenalMatchupFit({});
  assert("No splits → Γ MISSING", none.coverage === "MISSING");
  assert("No splits → Γ score 0", none.score === 0);

  // Weak damage everywhere → negative Γ.
  const cold = computeArsenalMatchupFit({
    pitchTypeSplits: [{ pitchType: "fastball", xSLG: 0.250, whiffPct: 35, usagePct: 100 }],
  });
  assert("Weak damage + high whiff → negative Γ score", cold.score < 0, `score=${cold.score}`);
  assert("Γ score winsorized within [-1, 1]", cold.score >= -1 && hot.score <= 1);
}

// ── aggregateOrderSplits + slgForSlot ───────────────────────────────────────
{
  const empty = aggregateOrderSplits([]);
  assert("Empty order rows → no splits", empty.splits.length === 0);
  assert("Empty order rows → overallSlg null", empty.overallSlg === null);
  assert("slgForSlot on empty → null", slgForSlot(empty, 4) === null);
}

{
  const rows: OrderSplitRow[] = [
    { battingOrderSlot: 4, ab: 4, h: 2, tb: 6, bb: 1 },
    { battingOrderSlot: 4, ab: 4, h: 1, tb: 4, bb: 0 },
    { battingOrderSlot: 1, ab: 5, h: 1, tb: 1, bb: 0 },
    { battingOrderSlot: null, ab: 3, h: 3, tb: 12, bb: 0 },
    { battingOrderSlot: 12, ab: 3, h: 3, tb: 12, bb: 0 },
  ];
  const agg = aggregateOrderSplits(rows);
  assert("Two valid slots aggregated", agg.splits.length === 2, `n=${agg.splits.length}`);
  assert("Cleanup SLG = 10TB/8AB = 1.25", slgForSlot(agg, 4) === 1.25, `slg=${slgForSlot(agg, 4)}`);
  assert("Leadoff SLG = 1TB/5AB = 0.20", slgForSlot(agg, 1) === 0.2, `slg=${slgForSlot(agg, 1)}`);
  assert("Untracked slot → null", slgForSlot(agg, 7) === null);
  assert("Overall SLG = 11/13 ≈ 0.846", Math.abs((agg.overallSlg ?? 0) - 0.846) < 0.002, `slg=${agg.overallSlg}`);
  assert("Slots sorted ascending", agg.splits[0].slot === 1 && agg.splits[1].slot === 4);
}

console.log(`\n[Phase 2 ingestion] ${passed}/${passed + failed} cases passed${failed > 0 ? ` (${failed} FAILED)` : ""}\n`);
if (failed > 0) process.exit(1);
