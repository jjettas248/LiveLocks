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
// (so CI fails on a re-inflating tag), the export is malformed, OR the export
// is too small/too degraded to be meaningful evidence (empty, or mostly/only
// UNAVAILABLE assessments) — see MIN_POPULATION_DEFAULT/MIN_VALID_ASSESSED_PCT_DEFAULT.
//
// Usage:
//   npx tsx scripts/plateIsoPopulationAudit.ts <export.json> \
//     [--max-elite-pct 25] [--min-population 20] [--min-valid-pct 50] [--json]
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
// A truncated/empty export (n=0) or one where every row falls back to
// UNAVAILABLE (0 valid assessments) drives elitePct to 0, which trivially
// satisfies the elite-prevalence cap below — the gate would report PASS while
// providing zero real validation evidence. These floors make that impossible:
// the export must contain a statistically meaningful number of hitters AND a
// meaningful share of them must have produced a usable (non-UNAVAILABLE) ISO
// assessment before `passed` can ever be true.
const MIN_POPULATION_DEFAULT = 20; // below this, prevalence % is noise
const MIN_VALID_ASSESSED_PCT_DEFAULT = 50; // percent — at least half the export must assess

interface HitterRow {
  id?: string;
  iso?: number | null;
  slg?: number | null;
  avg?: number | null;
  ab: number | null;
  split?: "vs_lhp" | "vs_rhp" | "overall";
  source?: IsoSource;
}

/**
 * Parse a numeric CLI flag value and fail closed (throw) on anything that
 * isn't a finite number within [min, max] — a malformed value (NaN from a
 * typo like "nope", a negative, an out-of-range percentage) must never
 * silently disable a gate threshold. `validAssessedPct < NaN` and
 * `n < NaN` are both always false in JS, so an un-validated bad flag would
 * recreate exactly the false-positive-PASS bug this gate exists to prevent.
 */
function parseNumberFlag(flag: string, raw: string | undefined, min: number, max: number): number {
  const n = Number(raw);
  if (raw === undefined || raw === "" || !Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${flag} must be a finite number in [${min}, ${max}], got "${raw ?? "<missing>"}"`);
  }
  return n;
}

function parseArgs(
  argv: string[],
): { path: string | null; maxElitePct: number; minPopulation: number; minValidAssessedPct: number; json: boolean } {
  let path: string | null = null;
  let maxElitePct = ELITE_PREVALENCE_CAP_DEFAULT;
  let minPopulation = MIN_POPULATION_DEFAULT;
  let minValidAssessedPct = MIN_VALID_ASSESSED_PCT_DEFAULT;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-elite-pct") maxElitePct = parseNumberFlag(a, argv[++i], 0, 100);
    else if (a === "--min-population") minPopulation = parseNumberFlag(a, argv[++i], 0, Number.MAX_SAFE_INTEGER);
    else if (a === "--min-valid-pct") minValidAssessedPct = parseNumberFlag(a, argv[++i], 0, 100);
    else if (a === "--json") json = true;
    else if (!a.startsWith("--")) path = a;
  }
  return { path, maxElitePct, minPopulation, minValidAssessedPct, json };
}

function rowToIso(r: HitterRow): number | null {
  if (r.iso != null) return r.iso;
  if (r.slg != null && r.avg != null) return r.slg - r.avg; // same-AB rate stats
  return null;
}

function main(): void {
  let path: string | null, maxElitePct: number, minPopulation: number, minValidAssessedPct: number, json: boolean;
  try {
    ({ path, maxElitePct, minPopulation, minValidAssessedPct, json } = parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(`[PLATE_ISO_POPULATION_AUDIT] FAILED — invalid CLI argument: ${(err as Error).message}`);
    process.exit(2);
    return;
  }
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
  const validAssessed = n - unavailable;
  const elitePct = n > 0 ? (100 * eliteEligible) / n : 0;
  const fallbackPct = n > 0 ? (100 * unavailable) / n : 0;
  const validAssessedPct = n > 0 ? (100 * validAssessed) / n : 0;

  // Population/coverage floors — checked BEFORE the elite-prevalence cap, since
  // an empty or all-UNAVAILABLE export drives elitePct to 0 and would otherwise
  // trivially satisfy `elitePct <= maxElitePct` while providing zero real
  // validation evidence (see MIN_POPULATION_DEFAULT/MIN_VALID_ASSESSED_PCT_DEFAULT
  // above).
  const populationReasons: string[] = [];
  if (n < minPopulation) {
    populationReasons.push(`population=${n} < required minimum ${minPopulation}`);
  }
  if (validAssessedPct < minValidAssessedPct) {
    populationReasons.push(
      `valid-assessed=${Number(validAssessedPct.toFixed(2))}% < required minimum ${minValidAssessedPct}%`,
    );
  }
  const elitePrevalenceOk = elitePct <= maxElitePct;

  const report = {
    version: ISO_ASSESSMENT_VERSION,
    population: n,
    validAssessed,
    validAssessedPct: Number(validAssessedPct.toFixed(2)),
    minPopulation,
    minValidAssessedPct,
    tierCounts,
    eliteEligible,
    elitePct: Number(elitePct.toFixed(2)),
    fallbackPct: Number(fallbackPct.toFixed(2)),
    maxElitePct,
    populationReasons,
    passed: populationReasons.length === 0 && elitePrevalenceOk,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[PLATE_ISO_POPULATION_AUDIT] v=${report.version} population=${n}`);
    console.log(`  tiers: ${JSON.stringify(tierCounts)}`);
    console.log(
      `  valid-assessed: ${validAssessed}/${n} (${report.validAssessedPct}%, min ${minValidAssessedPct}%)  ` +
        `min population: ${minPopulation}`,
    );
    console.log(`  ELITE prevalence: ${report.elitePct}% (cap ${maxElitePct}%)  fallback: ${report.fallbackPct}%`);
    if (populationReasons.length > 0) {
      console.log(`  FAIL — insufficient validation evidence: ${populationReasons.join("; ")}`);
    } else {
      console.log(`  ${elitePrevalenceOk ? "PASS" : "FAIL"} — Elite prevalence ${elitePrevalenceOk ? "within" : "EXCEEDS"} the selectivity cap`);
    }
  }

  process.exit(report.passed ? 0 : 1);
}

main();
