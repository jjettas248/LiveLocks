// Mound Radar — K display-split invariants.
//
// Regression guard for the "Pitcher Ks · Weak" contradiction: a pitcher can
// have elite skill (kStuffLabel) but only an average/poor platoon matchup
// (platoonKFitLabel) — those two must never be blended into a single grade,
// and neither may flatten an ordinary case to "Weak". Also covers
// kProjectionLabel and kLineValue's Over/Under/No Edge semantics.
//
// Run: npx tsx server/mlb/pregame/mound/moundKDisplaySplit.test.ts

import { computeMarketTags, marketSetupLabel, platoonKFitLabel } from "./marketTagger";
import { computeKProjectionLabel } from "./kProjectionLabel";
import { computeKLineValue } from "./kLineValue";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── kStuffLabel is pure pitcher skill, never blended with platoon fit ───────
{
  const highSkillWeakFit = computeMarketTags({ pitcherSkillScore: 9, opponentKProfileScore: 2.5, workloadScore: 5 });
  ok(highSkillWeakFit.kStuffLabel === "Elite", "kStuffLabel Elite for pitcherSkillScore=9 regardless of a weak platoon fit");
  ok(highSkillWeakFit.platoonKFitLabel === "Weak", "platoonKFitLabel Weak for opponentKProfileScore=2.5");

  const highSkillStrongFit = computeMarketTags({ pitcherSkillScore: 9, opponentKProfileScore: 9, workloadScore: 5 });
  ok(highSkillStrongFit.kStuffLabel === "Elite", "kStuffLabel Elite for pitcherSkillScore=9 with a strong platoon fit too");
  ok(highSkillStrongFit.platoonKFitLabel === "Elite", "platoonKFitLabel Elite for opponentKProfileScore=9");
}

// ── The exact Bryce Miller shape: elite skill + average matchup, both correct independently ──
{
  const result = computeMarketTags({ pitcherSkillScore: 8.6, opponentKProfileScore: 2.9, workloadScore: 6 });
  ok(result.kStuffLabel === "Elite" || result.kStuffLabel === "Strong", "kStuffLabel favorable for elite-skill pitcher");
  ok(result.platoonKFitLabel === "Weak", "platoonKFitLabel Weak when the platoon matchup is genuinely poor");
  ok(result.platoonKFitReason === "poor handedness fit", "platoonKFitReason set to 'poor handedness fit' when Weak");
}

// ── platoonKFitLabel must not flatten an ordinary/league-average matchup to Weak ──
ok(platoonKFitLabel(3.1) === "Solid", "3.1 → Solid (just above the Weak bar)");
ok(platoonKFitLabel(4.2) === "Solid", "4.2 → Solid (league-average band)");
ok(platoonKFitLabel(5.0) === "Solid", "5.0 → Solid (unconfirmed-lineup default)");
ok(platoonKFitLabel(6.4) === "Solid", "6.4 → Solid (just below the Strong bar)");
ok(platoonKFitLabel(6.5) === "Strong", "6.5 → Strong");
ok(platoonKFitLabel(8.0) === "Elite", "8.0 → Elite");
ok(platoonKFitLabel(3.0) === "Weak", "3.0 → Weak (boundary, not Solid)");
ok(platoonKFitLabel(1.0) === "Weak", "1.0 → Weak");

{
  const noReason = computeMarketTags({ pitcherSkillScore: 5, opponentKProfileScore: 5, workloadScore: 5 });
  ok(noReason.platoonKFitLabel === "Solid", "unconfirmed-lineup default (5) lands in Solid, not Weak");
  ok(noReason.platoonKFitReason == null, "no reason string when platoonKFitLabel is not Weak");
}

// ── marketSetupLabel — 4-grade boundary cases ───────────────────────────────
ok(marketSetupLabel(8.5) === "Elite", "marketSetupLabel 8.5 → Elite");
ok(marketSetupLabel(7.5) === "Strong", "marketSetupLabel 7.5 → Strong");
ok(marketSetupLabel(5.5) === "Solid", "marketSetupLabel 5.5 → Solid");
ok(marketSetupLabel(5.4) === "Weak", "marketSetupLabel 5.4 → Weak");

// ── kProjectionLabel ─────────────────────────────────────────────────────────
ok(computeKProjectionLabel(7.5, null) === "High", "projectedStrikeouts=7.5, no matchup-adjusted → High");
ok(computeKProjectionLabel(null, 7.5) === "High", "matchupAdjustedStrikeouts=7.5 preferred over projectedStrikeouts when both present");
ok(computeKProjectionLabel(6.2, null) === "Good", "6.2 → Good");
ok(computeKProjectionLabel(5.1, null) === "Average", "5.1 → Average");
ok(computeKProjectionLabel(4.0, null) === "Low", "4.0 → Low");
ok(computeKProjectionLabel(null, null) === null, "no projection available → null");

// ── kLineValue — no line, no row ────────────────────────────────────────────
ok(computeKLineValue(7.5, null, undefined) === null, "no line posted → null (no K Line Value row)");
ok(computeKLineValue(7.5, null, null) === null, "line explicitly null → null");

// ── kLineValue — Over/Under sign guard ──────────────────────────────────────
{
  const over = computeKLineValue(null, 7.2, 6.5);
  ok(over != null && over.margin === 0.7, "projection 7.2 vs line 6.5 → margin 0.7");
  ok(over != null && over.side === "Over", "margin +0.7 → side Over");
  ok(over != null && over.label === "Solid", "margin 0.7 → label Solid");

  const under = computeKLineValue(null, 6.8, 8.0);
  ok(under != null && Math.abs(under.margin - -1.2) < 1e-9, "projection 6.8 vs line 8.0 → margin -1.2");
  ok(under != null && under.side === "Under", "negative margin → side Under, not Over");
  ok(under != null && under.label === "Strong", "|margin|=1.2 → label Strong");
}

// ── kLineValue — the exact scenario the reviewer flagged: negative margin must never read as playable ──
{
  const negative = computeKLineValue(null, 7.2, 7.5);
  ok(negative != null && Math.abs(negative.margin - -0.3) < 1e-9, "projection 7.2 vs line 7.5 → margin -0.3");
  ok(negative != null && negative.side === "No Edge", "|margin|=0.3 < 0.5 → No Edge, not a soft Under");
  ok(negative != null && negative.label === "Weak", "No Edge always carries label Weak");
}

// ── kLineValue — projection 7.5 vs line 8.5 (the original test scenario) ───
{
  const passCase = computeKLineValue(7.5, null, 8.5);
  ok(passCase != null && passCase.margin === -1.0, "projection 7.5 vs line 8.5 → margin -1.0");
  ok(passCase != null && passCase.side === "Under", "margin -1.0 → side Under");
  ok(passCase != null && passCase.label === "Strong", "|margin|=1.0 → label Strong");
}

// ── kLineValue — zero-margin and Lean boundary ──────────────────────────────
{
  const zero = computeKLineValue(null, 7.1, 7.1);
  ok(zero != null && zero.margin === 0, "projection 7.1 vs line 7.1 → margin 0");
  ok(zero != null && zero.side === "No Edge", "margin 0 → No Edge");
  ok(zero != null && zero.label === "Weak", "margin 0 → label Weak (side/label never disagree)");

  const halfEdge = computeKLineValue(null, 7.0, 6.5);
  ok(halfEdge != null && halfEdge.margin === 0.5, "projection 7.0 vs line 6.5 → margin 0.5");
  ok(halfEdge != null && halfEdge.side === "Over", "margin 0.5 → side Over (at the No-Edge boundary)");
  ok(halfEdge != null && halfEdge.label === "Solid", "margin 0.5 → label Solid");
}

console.log(`\nmoundKDisplaySplit.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
