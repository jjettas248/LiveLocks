// The Plate — READ-ONLY ISO population audit / pre-deployment gate.
//
// Runs the canonical `assessIso` classifier over a REAL hitter population
// supplied as a historical export, and reports the full tier distribution,
// sample counts, fallback rate, and Elite prevalence. Intended to run in CI or an
// authorized production environment where a real export is available — it is the
// pre-deployment gate the sandbox cannot satisfy (no live Stats API / DB here).
//
// It imports only the pure classifier; it never touches the engine, bus, storage,
// or any live signal. It exits NON-ZERO when Elite prevalence exceeds the cap
// (so CI fails on a re-inflating tag) or the export is malformed.
//
// Usage:
//   npx tsx scripts/plateIsoPopulationAudit.ts <export.json> [--max-elite-pct 25] [--json]
//
// Export format — a JSON array of hitters, each either:
//   { "ab": 480, "slg": 0.512, "avg": 0.271, "split": "vs_rhp" }   // ISO = slg - avg
//   { "ab": 480, "iso": 0.241, "split": "vs_rhp", "source": "current_split" }
// `ab` is at-bats (the ISO denominator). `split`/`source` are optional
// (default "overall"/"current_overall").

import { readFileSync } from "fs";
import { assessIso, type IsoAssessment, type IsoSource } from "../server/mlb/pregamePowerRadar/isoAssessment";
import { ISO_ASSESSMENT_VERSION } from "../server/mlb/pregamePowerRadar/isoAssessmentConfig";

const ELITE_PREVALENCE_CAP_DEFAULT = 25; // percent — matches the runtime guardrail

interface HitterRow {
  id?: string;
  iso?: number | null;
  slg?: number | null;
  avg?: number | null;
  ab: number | null;
  split?: "vs_lhp" | "vs_rhp" | "overall";
  source?: IsoSource;
}

function parseArgs(argv: string[]): { path: string | null; maxElitePct: number; json: boolean } {
  let path: string | null = null;
  let maxElitePct = ELITE_PREVALENCE_CAP_DEFAULT;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-elite-pct") maxElitePct = Number(argv[++i]);
    else if (a === "--json") json = true;
    else if (!a.startsWith("--")) path = a;
  }
  return { path, maxElitePct, json };
}

function rowToIso(r: HitterRow): number | null {
  if (r.iso != null) return r.iso;
  if (r.slg != null && r.avg != null) return r.slg - r.avg; // same-AB rate stats
  return null;
}

function main(): void {
  const { path, maxElitePct, json } = parseArgs(process.argv.slice(2));
  if (!path) {
    console.error(
      "[PLATE_ISO_POPULATION_AUDIT] UNEXECUTED — no historical export provided.\n" +
        "  This is a required pre-deployment gate; run it against a real hitter export:\n" +
        "  npx tsx scripts/plateIsoPopulationAudit.ts <export.json> [--max-elite-pct 25]",
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

  const tierCounts: Record<string, number> = { ELITE: 0, STRONG: 0, AVERAGE: 0, WEAK: 0, UNAVAILABLE: 0 };
  let eliteEligible = 0;
  let unavailable = 0;
  const assessments: IsoAssessment[] = [];
  for (const r of rows) {
    const a = assessIso({
      rawIso: rowToIso(r),
      sampleAB: r.ab ?? null,
      split: r.split ?? "overall",
      source: r.source ?? (rowToIso(r) != null ? "current_overall" : "league_fallback"),
    });
    assessments.push(a);
    tierCounts[a.tier] = (tierCounts[a.tier] ?? 0) + 1;
    if (a.eliteEligible) eliteEligible++;
    if (a.tier === "UNAVAILABLE") unavailable++;
  }

  const n = rows.length;
  const elitePct = n > 0 ? (100 * eliteEligible) / n : 0;
  const fallbackPct = n > 0 ? (100 * unavailable) / n : 0;
  const report = {
    version: ISO_ASSESSMENT_VERSION,
    population: n,
    tierCounts,
    eliteEligible,
    elitePct: Number(elitePct.toFixed(2)),
    fallbackPct: Number(fallbackPct.toFixed(2)),
    maxElitePct,
    passed: elitePct <= maxElitePct,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[PLATE_ISO_POPULATION_AUDIT] v=${report.version} population=${n}`);
    console.log(`  tiers: ${JSON.stringify(tierCounts)}`);
    console.log(`  ELITE prevalence: ${report.elitePct}% (cap ${maxElitePct}%)  fallback: ${report.fallbackPct}%`);
    console.log(`  ${report.passed ? "PASS" : "FAIL"} — Elite prevalence ${report.passed ? "within" : "EXCEEDS"} the selectivity cap`);
  }

  process.exit(report.passed ? 0 : 1);
}

main();
