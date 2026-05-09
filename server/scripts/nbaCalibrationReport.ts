// NBA Calibration v2 — side-by-side cohort regression report.
//
// Run: `npx tsx server/scripts/nbaCalibrationReport.ts`
//
// COHORTS
// ───────
// The report relies on nbaCalibrationBackfill.ts having been run first.
// It reads calibrationTrack to split settled NBA plays into three groups:
//
//   PRE-V2          — calibrationTrack starts with "pre-nbaCalV2"
//                     Tagged by the backfill; play was created BEFORE the
//                     nba-calibration-v2 finalizer was deployed (createdAt <
//                     AUDIT_V2_CUTOVER_AT used in the backfill script).
//
//   POST-V2 CAPPED  — calibrationTrack contains "nbaCalV2" token
//                     Live stamp by probabilityFinalizer when a cap fired.
//
//   POST-V2 UNCAPPED — calibrationTrack has neither token
//                     Post-deploy play where no cap was applied.
//                     If the backfill has NOT been run yet, historical plays
//                     will also land here — run the backfill first.
//
// METRICS
// ───────
//   n             — total settled plays in cohort
//   gradeable     — cashed + missed only (excludes void/push)
//   hit rate      — cashed / gradeable
//   high bucket   — plays with prob >= 75%
//   p80+          — plays with prob >= 80%
//   avg prob      — mean stored probability (as %)
//   cap violations — high-bucket plays where result = "missed"
//                    (proxy: overconfident play that escaped the cap)
//   cap viol rate  — cap violations / high bucket

import { db } from "../db";
import { persistedPlays } from "@shared/schema";
import { and, eq, isNotNull } from "drizzle-orm";

// Keep in sync with nbaCalibrationBackfill.ts
const PRE_V2_TAG = "pre-nbaCalV2";
const V2_TOKEN = "nbaCalV2";
const HIGH_BUCKET_THRESH = 75;
const P80_THRESH = 80;

interface CohortStats {
  label: string;
  n: number;
  gradeable: number;
  hits: number;
  hitRate: string;
  highBucket: number;
  capViolations: number;
  capViolationRate: string;
  p80Plus: number;
  avgProb: string;
}

type CohortKey = "pre_v2" | "post_v2_capped" | "post_v2_uncapped";

function classify(track: string | null): CohortKey {
  const t = track ?? "";
  if (t.startsWith(PRE_V2_TAG)) return "pre_v2";
  if (t.includes(V2_TOKEN)) return "post_v2_capped";
  return "post_v2_uncapped";
}

function pct(n: number, d: number): string {
  if (d === 0) return "n/a";
  return `${((n / d) * 100).toFixed(1)}%`;
}

function buildStats(
  label: string,
  plays: Array<{ prob: string | null; result: string | null }>,
): CohortStats {
  let hits = 0;
  let gradeable = 0;
  let highBucket = 0;
  let capViolations = 0;
  let p80Plus = 0;
  let probSum = 0;
  let probCount = 0;

  for (const p of plays) {
    const prob = p.prob != null ? parseFloat(p.prob) : null;
    const res = p.result;

    if (prob != null && !isNaN(prob)) {
      probSum += prob;
      probCount++;
      const probPct = prob * 100;
      if (probPct >= HIGH_BUCKET_THRESH) highBucket++;
      if (probPct >= P80_THRESH) p80Plus++;

      if (res === "cashed" || res === "missed") {
        gradeable++;
        if (res === "cashed") hits++;
        if (probPct >= HIGH_BUCKET_THRESH && res === "missed") capViolations++;
      }
    }
  }

  return {
    label,
    n: plays.length,
    gradeable,
    hits,
    hitRate: pct(hits, gradeable),
    highBucket,
    capViolations,
    capViolationRate: pct(capViolations, highBucket),
    p80Plus,
    avgProb: probCount > 0 ? `${((probSum / probCount) * 100).toFixed(1)}%` : "n/a",
  };
}

function printTable(cohorts: CohortStats[]) {
  const COL_W = 22;
  const pad = (s: string | number) => String(s).padEnd(COL_W);

  const header = ["metric", ...cohorts.map((c) => c.label)].map(pad).join(" | ");
  const sep = "─".repeat(header.length);

  const rows: Array<[string, ...string[]]> = [
    ["plays (n)", ...cohorts.map((c) => String(c.n))],
    ["gradeable (c+m)", ...cohorts.map((c) => String(c.gradeable))],
    ["hit rate", ...cohorts.map((c) => c.hitRate)],
    [`high bucket (≥${HIGH_BUCKET_THRESH}%)`, ...cohorts.map((c) => String(c.highBucket))],
    [`p80+ (≥${P80_THRESH}%)`, ...cohorts.map((c) => String(c.p80Plus))],
    ["avg prob", ...cohorts.map((c) => c.avgProb)],
    ["cap violations", ...cohorts.map((c) => String(c.capViolations))],
    ["cap violation rate", ...cohorts.map((c) => c.capViolationRate)],
  ];

  console.log("\n" + sep);
  console.log(header);
  console.log(sep);
  for (const [metric, ...vals] of rows) {
    console.log([pad(metric), ...vals.map(pad)].join(" | "));
  }
  console.log(sep + "\n");
}

async function main() {
  console.log("[NBA_CAL_REPORT] Loading settled NBA plays…");
  console.log(
    "[NBA_CAL_REPORT] NOTE: run nbaCalibrationBackfill.ts first so historical plays are tagged",
  );

  const rows = await db
    .select({
      calibrationTrack: persistedPlays.calibrationTrack,
      prob: persistedPlays.prob,
      result: persistedPlays.result,
    })
    .from(persistedPlays)
    .where(
      and(
        eq(persistedPlays.sport, "nba"),
        isNotNull(persistedPlays.result),
      ),
    );

  console.log(`[NBA_CAL_REPORT] Loaded ${rows.length} settled NBA plays`);

  const buckets: Record<CohortKey, typeof rows> = {
    pre_v2: [],
    post_v2_capped: [],
    post_v2_uncapped: [],
  };

  for (const row of rows) {
    buckets[classify(row.calibrationTrack)].push(row);
  }

  const { pre_v2, post_v2_capped, post_v2_uncapped } = buckets;

  console.log(
    `[NBA_CAL_REPORT] Cohorts — pre-v2=${pre_v2.length}` +
    `  post-v2-capped=${post_v2_capped.length}` +
    `  post-v2-uncapped=${post_v2_uncapped.length}`,
  );
  if (post_v2_uncapped.length > 0 && pre_v2.length === 0) {
    console.warn(
      "[NBA_CAL_REPORT] WARN: no pre-nbaCalV2 plays found — historical plays may be in the" +
      " uncapped bucket. Run nbaCalibrationBackfill.ts to tag them.",
    );
  }

  const cohorts: CohortStats[] = [
    buildStats("pre-nbaCalV2", pre_v2),
    buildStats("post-v2 (capped)", post_v2_capped),
    buildStats("post-v2 (no cap)", post_v2_uncapped),
  ];

  console.log("\n══ NBA Calibration v2 — Side-by-Side Cohort Regression ══");
  printTable(cohorts);

  // Key regression signals
  const preHit = cohorts[0].gradeable > 0 ? cohorts[0].hits / cohorts[0].gradeable : null;
  const postCapHit = cohorts[1].gradeable > 0 ? cohorts[1].hits / cohorts[1].gradeable : null;
  const postNoCapHit = cohorts[2].gradeable > 0 ? cohorts[2].hits / cohorts[2].gradeable : null;

  console.log("── Key signals ──");
  if (preHit != null && postCapHit != null) {
    const delta = ((postCapHit - preHit) * 100).toFixed(1);
    const sign = parseFloat(delta) >= 0 ? "+" : "";
    console.log(`  Hit rate Δ (post-v2 capped vs pre-v2):   ${sign}${delta}pp`);
  }
  if (preHit != null && postNoCapHit != null) {
    const delta = ((postNoCapHit - preHit) * 100).toFixed(1);
    const sign = parseFloat(delta) >= 0 ? "+" : "";
    console.log(`  Hit rate Δ (post-v2 uncapped vs pre-v2): ${sign}${delta}pp`);
  }
  const vr = cohorts.map((c) => c.capViolationRate).join(" / ");
  console.log(`  Cap violation rate (pre / capped / uncapped): ${vr}`);
  console.log();

  if (rows.length === 0) {
    console.log("[NBA_CAL_REPORT] No settled plays found.");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[NBA_CAL_REPORT] FATAL:", err);
  process.exit(1);
});
