// The Plate — READ-ONLY ISO population audit / pre-deployment gate.
//
// Runs the canonical `assessIso` classifier over a REAL hitter population
// supplied as a historical export, and reports the full tier distribution,
// sample counts, fallback rate, and Elite prevalence. Intended to run in CI or an
// authorized production environment where a real export is available — it is the
// pre-deployment gate the sandbox cannot satisfy (no live Stats API / DB here).
//
// It imports only the pure classifier; it never touches the engine, bus, storage,
// or any live signal. It exits NON-ZERO when the gate cannot CERTIFY the release:
// an empty/too-small population, too few VALID assessments (so it provides no real
// validation evidence), Elite prevalence over the cap, or a malformed export.
//
// Usage:
//   npx tsx scripts/plateIsoPopulationAudit.ts <export.json> \
//     [--max-elite-pct 25] [--min-population 30] [--min-valid-pct 50] [--json]
//
// Export format — a JSON array of hitters, each either:
//   { "ab": 480, "slg": 0.512, "avg": 0.271, "split": "vs_rhp" }   // ISO = slg - avg
//   { "ab": 480, "iso": 0.241, "split": "vs_rhp", "source": "current_split" }
// `ab` is at-bats (the ISO denominator). `split`/`source` are optional
// (default "overall"/"current_overall").

import { readFileSync } from "fs";
import { assessIso, type IsoSource } from "../server/mlb/pregamePowerRadar/isoAssessment";
import { ISO_ASSESSMENT_VERSION } from "../server/mlb/pregamePowerRadar/isoAssessmentConfig";

export const ELITE_PREVALENCE_CAP_DEFAULT = 25; // percent — matches the runtime guardrail
// A gate that certifies "we validated on the real population" must actually SEE a
// real population. An empty export, or one where nearly every row fails closed
// (missing ISO/AB, out-of-range), provides no evidence and must FAIL, not pass.
export const MIN_POPULATION_DEFAULT = 30; // minimum rows to certify anything
export const MIN_VALID_PCT_DEFAULT = 50; // minimum % of rows producing a usable tier

export interface HitterRow {
  id?: string;
  iso?: number | null;
  slg?: number | null;
  avg?: number | null;
  ab: number | null;
  split?: "vs_lhp" | "vs_rhp" | "overall";
  source?: IsoSource;
}

export interface PopulationAuditOptions {
  maxElitePct: number;
  minPopulation: number;
  minValidPct: number;
}

export interface PopulationAuditReport {
  version: string;
  population: number;
  valid: number; // rows producing a usable tier (not UNAVAILABLE)
  unavailable: number;
  validPct: number;
  tierCounts: Record<string, number>;
  eliteEligible: number;
  elitePct: number;
  fallbackPct: number;
  thresholds: { maxElitePct: number; minPopulation: number; minValidPct: number };
  passed: boolean;
  failReasons: string[];
}

function rowToIso(r: HitterRow): number | null {
  if (r.iso != null) return r.iso;
  if (r.slg != null && r.avg != null) return r.slg - r.avg; // same-AB rate stats
  return null;
}

/** Pure evaluator — no I/O. A gate can only PASS on a real, mostly-valid population. */
export function buildPopulationReport(rows: readonly HitterRow[], opts: PopulationAuditOptions): PopulationAuditReport {
  const tierCounts: Record<string, number> = { ELITE: 0, STRONG: 0, AVERAGE: 0, WEAK: 0, UNAVAILABLE: 0 };
  let eliteEligible = 0;
  let unavailable = 0;
  for (const r of rows) {
    const rawIso = rowToIso(r);
    const a = assessIso({
      rawIso,
      sampleAB: r.ab ?? null,
      split: r.split ?? "overall",
      source: r.source ?? (rawIso != null ? "current_overall" : "league_fallback"),
    });
    tierCounts[a.tier] = (tierCounts[a.tier] ?? 0) + 1;
    if (a.eliteEligible) eliteEligible++;
    if (a.tier === "UNAVAILABLE") unavailable++;
  }
  const n = rows.length;
  const valid = n - unavailable;
  const elitePct = n > 0 ? (100 * eliteEligible) / n : 0;
  const validPct = n > 0 ? (100 * valid) / n : 0;
  const fallbackPct = n > 0 ? (100 * unavailable) / n : 0;

  const failReasons: string[] = [];
  if (n < opts.minPopulation) failReasons.push(`population ${n} < min ${opts.minPopulation} (no real-population evidence)`);
  if (validPct < opts.minValidPct) failReasons.push(`valid assessments ${validPct.toFixed(1)}% < min ${opts.minValidPct}% (export mostly failed closed)`);
  if (elitePct > opts.maxElitePct) failReasons.push(`Elite prevalence ${elitePct.toFixed(1)}% > cap ${opts.maxElitePct}%`);

  return {
    version: ISO_ASSESSMENT_VERSION,
    population: n,
    valid,
    unavailable,
    validPct: Number(validPct.toFixed(2)),
    tierCounts,
    eliteEligible,
    elitePct: Number(elitePct.toFixed(2)),
    fallbackPct: Number(fallbackPct.toFixed(2)),
    thresholds: { maxElitePct: opts.maxElitePct, minPopulation: opts.minPopulation, minValidPct: opts.minValidPct },
    passed: failReasons.length === 0,
    failReasons,
  };
}

function parseArgs(argv: string[]): { path: string | null; opts: PopulationAuditOptions; json: boolean } {
  let path: string | null = null;
  const opts: PopulationAuditOptions = {
    maxElitePct: ELITE_PREVALENCE_CAP_DEFAULT,
    minPopulation: MIN_POPULATION_DEFAULT,
    minValidPct: MIN_VALID_PCT_DEFAULT,
  };
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-elite-pct") opts.maxElitePct = Number(argv[++i]);
    else if (a === "--min-population") opts.minPopulation = Number(argv[++i]);
    else if (a === "--min-valid-pct") opts.minValidPct = Number(argv[++i]);
    else if (a === "--json") json = true;
    else if (!a.startsWith("--")) path = a;
  }
  return { path, opts, json };
}

function main(): void {
  const { path, opts, json } = parseArgs(process.argv.slice(2));
  if (!path) {
    console.error(
      "[PLATE_ISO_POPULATION_AUDIT] UNEXECUTED — no historical export provided.\n" +
        "  This is a required pre-deployment gate; run it against a real hitter export:\n" +
        "  npx tsx scripts/plateIsoPopulationAudit.ts <export.json> [--max-elite-pct 25] [--min-population 30] [--min-valid-pct 50]",
    );
    process.exit(2);
  }

  let rows: HitterRow[];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("export must be a JSON array of hitter rows");
    rows = parsed as HitterRow[];
  } catch (err) {
    console.error(`[PLATE_ISO_POPULATION_AUDIT] FAILED to read export "${path}": ${(err as Error).message}`);
    process.exit(2);
    return;
  }

  const report = buildPopulationReport(rows, opts);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[PLATE_ISO_POPULATION_AUDIT] v=${report.version} population=${report.population} valid=${report.valid} (${report.validPct}%)`);
    console.log(`  tiers: ${JSON.stringify(report.tierCounts)}`);
    console.log(`  ELITE prevalence: ${report.elitePct}% (cap ${opts.maxElitePct}%)  fallback: ${report.fallbackPct}%`);
    if (report.passed) {
      console.log(`  PASS — real population validated, Elite prevalence within the selectivity cap`);
    } else {
      console.log(`  FAIL — ${report.failReasons.join("; ")}`);
    }
  }

  process.exit(report.passed ? 0 : 1);
}

// Only run the CLI when invoked directly (so the pure evaluator can be imported in tests).
if (process.argv[1] && /plateIsoPopulationAudit\.ts$/.test(process.argv[1])) {
  main();
}
