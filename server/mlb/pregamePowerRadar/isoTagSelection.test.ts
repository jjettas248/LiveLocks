// The Plate — ISO tag selectivity, champion-safety, and distribution guardrail.
//
// Locks the fix for the universal "Elite Isolated Power" defect: the driver is
// still EMITTED on the same score-side condition (so the champion's evidence
// count / suppression / publication are untouched), but the LABEL + display gate
// now come from the canonical true-ISO assessment.
//
// Run: npx tsx server/mlb/pregamePowerRadar/isoTagSelection.test.ts

import { computeBatterPowerProfile, type BatterPowerInputs } from "./batterPowerProfile";
import type { PowerDriver, PregamePowerSignal } from "./types";
import { countPositiveDrivers, JUL20_POSITIVE_DRIVER_KEYS } from "./modelVersions/plateDriverUniverse";
import {
  buildIsoDistributionReport,
  recordAndLogIsoDistribution,
  __resetIsoDistributionHistory,
} from "./isoDistributionAudit";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

// A power profile that fires the ISO emission (inflated on-contact xISO ≈ .25 →
// sIso ≈ 9.4 ≥ 6.5) — the exact upstream condition that made the tag universal.
const powerBase = (over: Partial<BatterPowerInputs> = {}): BatterPowerInputs => ({
  xISO: 0.25, // on-contact proxy (score input) — fires the driver emission
  xSLG: 0.5,
  barrelRatePct: 12,
  hardHitRatePct: 45,
  exitVelocity: 90,
  maxEV: 110,
  flyBallPct: 35,
  hrFBRatioPct: 15,
  pullRatePct: 42,
  sweetSpotPct: 35,
  xwOBA: 0.36,
  battedBallEvents: 200,
  ...over,
});

const isoDriver = (inputs: BatterPowerInputs): PowerDriver | undefined =>
  computeBatterPowerProfile(inputs).drivers.find((d) => d.key === "power_iso");

// ── Regression: former universal tag is now gated by true ISO ───────────────
{
  // Inflated on-contact xISO fires the emission, but with NO true-ISO evidence
  // the label is NOT "Elite" and the chip is hidden. Pre-fix this was always
  // "Elite Isolated Power".
  const noTrue = isoDriver(powerBase());
  ok(noTrue != null, "[regression] power_iso still EMITTED (emission unchanged)");
  ok(noTrue?.label !== "Elite Isolated Power", "[regression] no true ISO → not 'Elite Isolated Power'");
  ok(noTrue?.displayEligible === false, "[regression] no true ISO → chip hidden (displayEligible false)");

  // Genuinely elite, reliable, matchup-aware true ISO → the real Elite tag.
  const elite = isoDriver(powerBase({ trueIso: 0.3, trueIsoSamplePA: 500, trueIsoSplit: "vs_rhp", trueIsoSource: "current_split" }));
  ok(elite?.label === "Elite Isolated Power", "legit elite true ISO → 'Elite Isolated Power'");
  ok(elite?.displayEligible === true, "legit elite → chip shown");
  ok(elite?.tier === "ELITE", "legit elite → tier stamped ELITE");

  // Ordinary true ISO → valid but no promotional chip.
  const ordinary = isoDriver(powerBase({ trueIso: 0.15, trueIsoSamplePA: 500, trueIsoSplit: "vs_rhp", trueIsoSource: "current_split" }));
  ok(ordinary?.label !== "Elite Isolated Power", "ordinary true ISO → not Elite");
  ok(ordinary?.displayEligible === false, "ordinary true ISO → chip hidden");

  // Strong true ISO → Strong label, shown.
  const strong = isoDriver(powerBase({ trueIso: 0.25, trueIsoSamplePA: 500, trueIsoSplit: "vs_rhp", trueIsoSource: "current_split" }));
  ok(strong?.label === "Strong Isolated Power", "strong true ISO → 'Strong Isolated Power'");
  ok(strong?.displayEligible === true, "strong true ISO → chip shown");
}

// ── Champion-safety: emission (evidence count) is invariant to the tag change ──
{
  // The driver is emitted positively in every case above regardless of true ISO,
  // so countPositiveDrivers (key+direction) is identical → champion suppression /
  // publication cannot move because of this repair.
  const cases: BatterPowerInputs[] = [
    powerBase(),
    powerBase({ trueIso: 0.3, trueIsoSamplePA: 500, trueIsoSource: "current_split", trueIsoSplit: "vs_rhp" }),
    powerBase({ trueIso: 0.15, trueIsoSamplePA: 500, trueIsoSource: "current_split", trueIsoSplit: "vs_rhp" }),
    powerBase({ trueIso: null }),
  ];
  const counts = cases.map((c) => countPositiveDrivers(computeBatterPowerProfile(c).drivers, JUL20_POSITIVE_DRIVER_KEYS));
  ok(counts.every((n) => n === counts[0]), "positiveDriverCount identical across all true-ISO states (champion-safe)");
  ok(counts[0] >= 1, "power_iso counts as a positive JUL20 driver regardless of display gate");
  // score10 also unchanged by the true-ISO value (it is display-only).
  const s1 = computeBatterPowerProfile(powerBase()).score10;
  const s2 = computeBatterPowerProfile(powerBase({ trueIso: 0.3, trueIsoSamplePA: 500 })).score10;
  ok(s1 === s2, "score10 independent of true ISO (display-only)");
}

// ── Identity independence ──────────────────────────────────────────────────
{
  // The scorer takes NO player identity; identical inputs → identical output.
  const a = computeBatterPowerProfile(powerBase({ trueIso: 0.3, trueIsoSamplePA: 500 }));
  const b = computeBatterPowerProfile(powerBase({ trueIso: 0.3, trueIsoSamplePA: 500 }));
  ok(JSON.stringify(a) === JSON.stringify(b), "deterministic: same inputs → identical drivers/score (no identity input)");
}

// ── Mixed slate differentiation (§10.5) ────────────────────────────────────
{
  const slate = {
    elite: isoDriver(powerBase({ trueIso: 0.3, trueIsoSamplePA: 500, trueIsoSplit: "vs_rhp", trueIsoSource: "current_split" })),
    strong: isoDriver(powerBase({ trueIso: 0.25, trueIsoSamplePA: 500, trueIsoSplit: "vs_rhp", trueIsoSource: "current_split" })),
    ordinary: isoDriver(powerBase({ trueIso: 0.15, trueIsoSamplePA: 500, trueIsoSplit: "vs_rhp", trueIsoSource: "current_split" })),
    smallSampleInflated: isoDriver(powerBase({ trueIso: 0.45, trueIsoSamplePA: 25, trueIsoSplit: "vs_lhp", trueIsoSource: "current_split" })),
    malformed: isoDriver(powerBase({ trueIso: 24, trueIsoSamplePA: 500, trueIsoSplit: "vs_rhp", trueIsoSource: "current_split" })),
  };
  const eliteLabels = Object.values(slate).filter((d) => d?.label === "Elite Isolated Power");
  ok(eliteLabels.length === 1, "mixed slate: exactly ONE hitter earns 'Elite Isolated Power'");
  ok(slate.elite?.label === "Elite Isolated Power", "mixed slate: the legit elite earns it");
  ok(slate.malformed?.displayEligible === false && slate.malformed?.tier === "UNAVAILABLE", "mixed slate: malformed (pct-scale) never elite");
  ok(slate.smallSampleInflated?.displayEligible === false, "mixed slate: small-sample inflated split never elite");
  ok(slate.ordinary?.displayEligible === false, "mixed slate: ordinary shows no promotional chip");
  // Every hitter still EMITTED the driver (evidence count unchanged), but the
  // displayed classification is differentiated.
  ok(Object.values(slate).every((d) => d != null && d.direction === "positive"), "mixed slate: all still emit power_iso (evidence invariant)");
  const distinctTiers = new Set(Object.values(slate).map((d) => d?.tier));
  ok(distinctTiers.size >= 3, "mixed slate: output is differentiated across tiers");
}

// ── Distribution guardrail ─────────────────────────────────────────────────
function sig(over: Partial<PowerDriver>[], batterName = "x"): PregamePowerSignal {
  return { drivers: over as PowerDriver[], batterName } as unknown as PregamePowerSignal;
}
{
  __resetIsoDistributionHistory();
  // 8 hitters, 6 displayed Elite → 75% ELITE prevalence (deliberately corrupted).
  const corrupt: PregamePowerSignal[] = [];
  for (let i = 0; i < 8; i++) {
    const elite = i < 6;
    corrupt.push(
      sig([
        { key: "power_iso", label: elite ? "Elite Isolated Power" : "Isolated Power", direction: "positive", displayEligible: elite, tier: elite ? "ELITE" : "AVERAGE" },
      ]),
    );
  }
  const report = buildIsoDistributionReport(corrupt);
  ok(report.eligibleEvaluated === 8, "audit counts all ISO candidates (evaluated denominator)");
  ok(report.tierCounts.ELITE === 6, "audit tallies ELITE tier count");
  ok(Math.abs(report.evaluatedElitePrevalence - 0.75) < 1e-9, "audit computes 75% evaluated elite prevalence");
  ok(report.elitePrevalenceExceeded === true, ">25% elite prevalence flagged");

  // Healthy, selective distribution does not trip the flag.
  const healthy: PregamePowerSignal[] = [];
  for (let i = 0; i < 10; i++) {
    const elite = i === 0; // 1/10 = 10%
    healthy.push(
      sig([
        { key: "power_iso", label: elite ? "Elite Isolated Power" : "Isolated Power", direction: "positive", displayEligible: elite, tier: elite ? "ELITE" : "WEAK" },
        { key: "power_barrel", label: "High Barrel Rate", direction: "positive" },
      ]),
    );
  }
  const healthyReport = buildIsoDistributionReport(healthy);
  ok(healthyReport.elitePrevalenceExceeded === false, "selective (10%) distribution does not flag");
  ok(!Number.isNaN(healthyReport.tagPrevalence["power_barrel"]), "tag prevalence computed for displayed tags");

  // Denominator proof (§ item 3): evaluated includes EVERY ISO-assessed hitter,
  // including suppressed ones absent from the displayed set.
  const evaluated: PregamePowerSignal[] = [
    sig([{ key: "power_iso", label: "Elite Isolated Power", direction: "positive", displayEligible: true, tier: "ELITE" }]),
    sig([{ key: "power_iso", label: "Isolated Power", direction: "positive", displayEligible: false, tier: "AVERAGE" }]),
    sig([{ key: "power_iso", label: "Elite Isolated Power", direction: "positive", displayEligible: true, tier: "ELITE" }]), // suppressed hitter
  ];
  const displayed = evaluated.slice(0, 2); // the 3rd is suppressed / not public
  const split = buildIsoDistributionReport(evaluated, displayed);
  ok(split.eligibleEvaluated === 3, "evaluated denominator counts ALL ISO-assessed hitters (incl. suppressed)");
  ok(split.displayedCards === 1, "displayed denominator counts only public cards with a visible chip");
  ok(Math.abs(split.evaluatedElitePrevalence - 2 / 3) < 1e-9, "evaluated elite prevalence uses the full denominator");
  ok(Math.abs(split.displayedElitePrevalence - 1) < 1e-9, "displayed elite prevalence uses the displayed denominator");

  // Logging path never throws.
  let threw = false;
  try {
    recordAndLogIsoDistribution("2026-08-03", report);
    recordAndLogIsoDistribution("2026-08-02", healthyReport);
  } catch {
    threw = true;
  }
  ok(!threw, "recordAndLogIsoDistribution never throws");
}

console.log(`\nisoTagSelection.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
