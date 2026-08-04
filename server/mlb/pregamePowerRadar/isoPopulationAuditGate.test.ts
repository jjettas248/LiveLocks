// The Plate — pre-deployment population-audit GATE semantics.
//
// The gate must only PASS on a real, mostly-valid population. An empty export, a
// too-small one, or one where nearly every row fails closed provides no
// validation evidence and must FAIL — otherwise a truncated export would certify
// a deploy it never checked.
//
// Run: npx tsx server/mlb/pregamePowerRadar/isoPopulationAuditGate.test.ts

import {
  buildPopulationReport,
  type HitterRow,
  type PopulationAuditOptions,
} from "../../../scripts/plateIsoPopulationAudit";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const OPTS: PopulationAuditOptions = { maxElitePct: 25, minPopulation: 30, minValidPct: 50 };

// A realistic, mostly-valid population (40 rows, ISO around league) — should PASS.
function realisticPopulation(n: number): HitterRow[] {
  const rows: HitterRow[] = [];
  for (let i = 0; i < n; i++) {
    const iso = 0.1 + (i % 20) * 0.008; // .100–.252 spread
    rows.push({ ab: 450, slg: 0.34 + iso, avg: 0.34, split: "vs_rhp" });
  }
  return rows;
}

// ── Empty / unusable exports FAIL (no evidence) ────────────────────────────
{
  const empty = buildPopulationReport([], OPTS);
  ok(empty.passed === false, "empty export FAILS the gate");
  ok(empty.failReasons.some((r) => r.includes("population")), "empty export cites insufficient population");

  // Every row fails closed (missing ISO/AB, or pct-scale) → no valid evidence.
  const garbage: HitterRow[] = Array.from({ length: 40 }, () => ({ ab: null, iso: null }));
  const g = buildPopulationReport(garbage, OPTS);
  ok(g.passed === false, "all-unavailable export FAILS the gate");
  ok(g.valid === 0 && g.unavailable === 40, "all-unavailable export has zero valid assessments");
  ok(g.failReasons.some((r) => r.includes("valid")), "all-unavailable export cites too few valid assessments");

  // Percentage-scale contamination on every row → also fails closed.
  const pctScale: HitterRow[] = Array.from({ length: 40 }, () => ({ ab: 400, iso: 24 }));
  ok(buildPopulationReport(pctScale, OPTS).passed === false, "all pct-scale export FAILS the gate");

  // A too-small (but valid) population still fails — not enough evidence.
  const tiny = buildPopulationReport(realisticPopulation(5), OPTS);
  ok(tiny.passed === false && tiny.failReasons.some((r) => r.includes("population")), "5-row population FAILS (below min)");
}

// ── Healthy population PASSES; over-cap FAILS ──────────────────────────────
{
  const healthy = buildPopulationReport(realisticPopulation(40), OPTS);
  ok(healthy.population === 40 && healthy.valid === 40, "healthy population: all rows valid");
  ok(healthy.passed === true, "realistic 40-row population PASSES");
  ok(healthy.elitePct <= OPTS.maxElitePct, "healthy population Elite prevalence within cap");

  // Corrupt every hitter to a huge ISO → elite prevalence explodes → FAIL.
  const hot: HitterRow[] = Array.from({ length: 40 }, () => ({ ab: 500, slg: 0.62, avg: 0.31, split: "vs_rhp" }));
  const hotReport = buildPopulationReport(hot, OPTS);
  ok(hotReport.passed === false, "over-cap Elite prevalence FAILS the gate");
  ok(hotReport.failReasons.some((r) => r.includes("Elite prevalence")), "over-cap cites Elite prevalence");
}

console.log(`\nisoPopulationAuditGate.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
