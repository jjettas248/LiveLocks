// The Plate — champion vs challenger replay / forward-comparison report.
//
// Read-only. Mutates nothing.
//
//   npx tsx server/mlb/pregamePowerRadar/scripts/comparePlateModels.ts \
//     --from=2026-07-19 --to=2026-07-24
//
// HONEST LIMITS — read before trusting any number this prints.
//
// The Plate has never persisted its raw pregame inputs. Only DERIVED component
// scores survive in `diagnostics`; there is no Plate equivalent of
// hr_radar_evaluation_snapshots.rawInputs. The specific inputs the champion and
// challenger disagree about — pitcher barrel/hard-hit/fly-ball allowed, last-3
// start ERA, days of rest, battedBallEvents, raw park factor, raw weather, raw
// lineup context, raw BvP counts — were never written to disk.
//
// So for any date BEFORE this instrumentation shipped, a champion-vs-challenger
// replay cannot be reconstructed honestly, and this script will not fabricate
// one. It reports the champion-side record from what genuinely persisted, names
// the missing inputs, and says plainly that the challenger side is unavailable.
// Trustworthy comparison begins with forward collection.

import { getPlateModelComparison } from "../statsService";
import { slateDateET } from "../../../utils/dateUtils";

const MISSING_HISTORICAL_INPUTS = [
  "pitcher barrelAllowedPct / hardHitAllowedPct / flyBallAllowedPct",
  "pitcher last3StartERA",
  "pitcher daysSinceLastStart",
  "batter battedBallEvents",
  "raw park HR factor",
  "raw weather (temperature / wind speed / wind direction)",
  "raw lineup context (teamImpliedRuns / obpAhead)",
  "raw BvP counts beyond bvpHits / bvpSampleSize",
];

function parseArgs() {
  const a = process.argv.slice(2);
  const from = a.find((x) => x.startsWith("--from="))?.split("=")[1];
  const to = a.find((x) => x.startsWith("--to="))?.split("=")[1];
  const date = a.find((x) => x.startsWith("--date="))?.split("=")[1];
  const today = slateDateET();
  return { from: date ?? from ?? today, to: date ?? to ?? today };
}

function pct(v: number | null): string {
  return v == null ? "  n/a" : `${v.toFixed(1)}%`;
}

async function main() {
  const { from, to } = parseArgs();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    console.error("[PLATE_MODEL_COMPARE] --from/--to must be YYYY-MM-DD");
    process.exit(1);
  }
  console.log(`[PLATE_MODEL_COMPARE] range=${from}..${to} (read-only)`);

  const r = await getPlateModelComparison(from, to);

  console.log(`\nchampion:   ${r.championVersion}`);
  console.log(`challenger: ${r.challengerVersion}`);
  console.log(`rows scanned: ${r.rowsScanned}`);

  const u = r.challengerUnavailable;
  const comparable = r.rowsScanned - u.total;

  console.log("\n── CHAMPION (production) ───────────────────────────────────");
  console.log(`  public candidates : ${r.champion.publicCandidates}`);
  console.log(`  HR  calls/hits    : ${r.champion.hr.calls}/${r.champion.hr.hits}  rate ${pct(r.champion.hr.hitRate)}`);
  console.log(`  TB  calls/hits    : ${r.champion.tb.calls}/${r.champion.tb.hits}  rate ${pct(r.champion.tb.hitRate)}`);
  console.log(`  HR recall         : ${r.recall.championCalledHrs}/${r.recall.allSlateHrs} slate HRs`);

  if (comparable === 0) {
    console.log("\n── CHALLENGER ──────────────────────────────────────────────");
    console.log("  UNAVAILABLE — no frozen champion/challenger comparison exists for this range.");
    console.log(`  rows without a comparison: ${u.total}`);
    console.log(`    no record stored : ${u.noRecord}   (predates this instrumentation)`);
    console.log(`    shadow disabled  : ${u.disabled}`);
    console.log(`    shadow failed    : ${u.failed}`);
    console.log(`    inputs missing   : ${u.inputsMissing}`);
    console.log("\n  A replay for this range is NOT possible and will not be fabricated.");
    console.log("  The Plate never persisted the raw pregame inputs the two models differ on:");
    for (const m of MISSING_HISTORICAL_INPUTS) console.log(`    - ${m}`);
    console.log("\n  Re-fetching them today would be leakage: season rates have moved since");
    console.log("  those dates, so they are no longer prediction-time values.");
    console.log("\n  Next step: deploy with PLATE_SHADOW_CHALLENGER_ENABLED=true and re-run");
    console.log("  this report once forward collection has accumulated. Every candidate");
    console.log("  built from that point carries a frozen, hash-verified comparison.");
    console.log("\n[PLATE_MODEL_COMPARE] DONE — champion record only, challenger unavailable.");
    process.exit(0);
  }

  console.log("\n── CHALLENGER (shadow) ─────────────────────────────────────");
  console.log(`  comparable rows   : ${comparable} of ${r.rowsScanned}`);
  if (u.total > 0) {
    console.log(`  excluded rows     : ${u.total} (noRecord=${u.noRecord} disabled=${u.disabled} failed=${u.failed} inputsMissing=${u.inputsMissing})`);
  }
  console.log(`  public candidates : ${r.challenger.publicCandidates}`);
  console.log(`  HR  calls/hits    : ${r.challenger.hr.calls}/${r.challenger.hr.hits}  rate ${pct(r.challenger.hr.hitRate)}`);
  console.log(`  TB  calls/hits    : ${r.challenger.tb.calls}/${r.challenger.tb.hits}  rate ${pct(r.challenger.tb.hitRate)}`);
  console.log(`  HR recall         : ${r.recall.challengerCalledHrs}/${r.recall.allSlateHrs} slate HRs`);

  console.log("\n── DISAGREEMENTS ───────────────────────────────────────────");
  console.log(`  total             : ${r.disagreements.total}`);
  console.log(`  champion only     : ${r.disagreements.championOnly}`);
  console.log(`  challenger only   : ${r.disagreements.challengerOnly}`);
  console.log(`  tier changes      : ${r.disagreements.tierChanges}`);
  console.log(`  market changes    : ${r.disagreements.marketChanges}`);

  console.log("\n── WINNER / LOSS ANALYSIS ──────────────────────────────────");
  console.log(`  champion kept, challenger removed : ${r.winnerLossAnalysis.championKeptChallengerRemoved}`);
  console.log(`  challenger added, champion missed : ${r.winnerLossAnalysis.challengerAddedChampionMissed}`);
  console.log(`  both called                       : ${r.winnerLossAnalysis.bothCalled}`);
  console.log(`  neither called                    : ${r.winnerLossAnalysis.neitherCalled}`);
  console.log(`  losers the challenger would add   : ${r.addedLosers.length}`);

  const attr = Object.entries(r.attributionBreakdown).sort((a, b) => b[1] - a[1]);
  if (attr.length > 0) {
    console.log("\n── DELTA ATTRIBUTION ───────────────────────────────────────");
    for (const [k, v] of attr) console.log(`  ${k.padEnd(28)} ${v}`);
  }

  if (r.lostWinners.length > 0) {
    console.log("\n── LOST WINNERS (challenger would have removed) ────────────");
    for (const w of r.lostWinners.slice(0, 25)) {
      console.log(`  ${w.sessionDate} ${w.batterName} champ=${w.championTier}/${w.championScore10} chal=${w.challengerTier}/${w.challengerScore10} [${w.attribution.join(",") || "none"}]`);
    }
    if (r.lostWinners.length > 25) console.log(`  … and ${r.lostWinners.length - 25} more (truncated for display)`);
  }
  if (r.gainedWinners.length > 0) {
    console.log("\n── GAINED WINNERS (challenger would have added) ────────────");
    for (const w of r.gainedWinners.slice(0, 25)) {
      console.log(`  ${w.sessionDate} ${w.batterName} champ=${w.championTier}/${w.championScore10} chal=${w.challengerTier}/${w.challengerScore10} [${w.attribution.join(",") || "none"}]`);
    }
    if (r.gainedWinners.length > 25) console.log(`  … and ${r.gainedWinners.length - 25} more (truncated for display)`);
  }

  console.log("\n[PLATE_MODEL_COMPARE] DONE");
  process.exit(0);
}

main().catch((err) => {
  console.error("[PLATE_MODEL_COMPARE] FATAL:", err);
  process.exit(1);
});
