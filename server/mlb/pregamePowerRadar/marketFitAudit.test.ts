// Pre-Game Power Radar — primary-market fit audit invariants.
// Run: npx tsx server/mlb/pregamePowerRadar/marketFitAudit.test.ts

import { auditPrimaryMarketFit } from "./marketFitAudit";
import { computeMarketTags } from "./marketTagger";
import type { PregameMarketSetup } from "./types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── (a) primary=HR/Solid, secondary=TB/Strong → flagged ────────────────────
const solidHrStrongTb: PregameMarketSetup[] = [
  { market: "home_runs", setupScore: 6.0, setupLabel: "Solid", isPrimary: true },
  { market: "total_bases", setupScore: 7.5, setupLabel: "Strong", isPrimary: false },
];
const r1 = auditPrimaryMarketFit(solidHrStrongTb);
ok(r1.flagged === true, `Solid primary with a Strong secondary must flag (got ${JSON.stringify(r1)})`);
ok(r1.primaryMarket === "home_runs" && r1.betterFitMarket === "total_bases", "reports the correct markets");

// ── (b) primary=HR/Elite, secondary=TB/Solid → not flagged ─────────────────
const eliteHrSolidTb: PregameMarketSetup[] = [
  { market: "home_runs", setupScore: 9.0, setupLabel: "Elite", isPrimary: true },
  { market: "total_bases", setupScore: 6.2, setupLabel: "Solid", isPrimary: false },
];
ok(auditPrimaryMarketFit(eliteHrSolidTb).flagged === false, "primary already the best fit must not flag");

// ── (c) single-market signal → not flagged ─────────────────────────────────
const single: PregameMarketSetup[] = [
  { market: "home_runs", setupScore: 8.0, setupLabel: "Strong", isPrimary: true },
];
ok(auditPrimaryMarketFit(single).flagged === false, "a lone market has nothing to compare against");

// ── (d) same-rank ties never flag ──────────────────────────────────────────
const tie: PregameMarketSetup[] = [
  { market: "home_runs", setupScore: 7.2, setupLabel: "Strong", isPrimary: true },
  { market: "total_bases", setupScore: 7.4, setupLabel: "Strong", isPrimary: false },
];
ok(auditPrimaryMarketFit(tie).flagged === false, "equal fit ranks must not flag (strictly lower only)");

// ── (e) real engine scenario: eliteHrShape can select HR primary even when
//     hrScore < tbScore — construct exact inputs that reach this branch in
//     marketTagger.ts's computeMarketTags, proving the audit condition is
//     reachable from real engine logic, not just a synthetic fixture. ───────
const real = computeMarketTags({
  batterPowerScore: 6.0,
  pitcherVulnerabilityScore: 6.0,
  parkWeatherScore: 6.0,
  hrFBRatioPct: null,
  xISO: 0.25, // >= 0.2 → eliteHrShape true, forces HR primary despite hrScore < tbScore
  hardHitRatePct: 46.8, // → hardHit component ~9.0, pushes tbScore's fit above hrScore's
});
ok(real.primaryMarket === "home_runs", `sanity: eliteHrShape selects HR primary (got ${real.primaryMarket})`);
const hrSetup = real.marketSetups.find((m) => m.market === "home_runs")!;
const tbSetup = real.marketSetups.find((m) => m.market === "total_bases")!;
ok(hrSetup.setupScore < tbSetup.setupScore, `sanity: HR (primary) fit score is actually lower than TB's (${hrSetup.setupScore} vs ${tbSetup.setupScore})`);
const realAudit = auditPrimaryMarketFit(real.marketSetups);
ok(realAudit.flagged === true, `real engine scenario must flag (got ${JSON.stringify(realAudit)})`);

console.log(`\nmarketFitAudit.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
