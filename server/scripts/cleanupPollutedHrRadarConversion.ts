/**
 * One-shot admin cleanup — suppress empirical-calibration-inflated HR Radar rows.
 *
 * CONTEXT (2026-06-25 audit): a selection-biased empirical calibration produced
 * HR-conversion probabilities of ~0.95 (Laplace `(cashed+1)/(n+2)` on all-positive
 * buckets — e.g. 20/21=0.9524, 21/22=0.9545). The forward fix
 * (EMPIRICAL_CALIBRATION_CEILING + required non-HR negatives) stops NEW inflation,
 * but rows already persisted today still carry the impossible values in
 * `diagnosticsSnapshot.scoreContract.{conversionProbability,peakConversionProbability}`.
 *
 * This script SUPPRESSES (clamps) only those polluted values on ACTIVE rows from a
 * single session (default: today ET). It is deliberately conservative:
 *
 *   • ACTIVE-ONLY: touches rows with status='live' AND gradingStatus='active'.
 *     Resolved rows (status hit/miss, any graded gradingStatus) are never read for
 *     mutation — so the official W/L record, ROI, and historical grading are NEVER
 *     rewritten.
 *   • SNAPSHOT-FIRST: every affected row (full scoreContract + ids) is written to a
 *     timestamped JSON backup before any DB write. Nothing is mutated until the
 *     snapshot is on disk.
 *   • DRY-RUN BY DEFAULT: prints exactly what it would change. Pass `--apply` to
 *     write. Pass `--date=YYYY-MM-DD` to target a non-today session.
 *
 *   • SCOPE: clamps the two conversion-probability fields in
 *     `diagnosticsSnapshot.scoreContract`, and — because `/api/mlb/hr-radar`
 *     reads and SORTS by them directly — also backs the same inflation out of the
 *     `currentReadinessScore` / `peakReadinessScore` columns (the engine adds
 *     `conversion × 60` to readiness, so a polluted row would otherwise keep
 *     displaying/sorting at ~100 until the next engine write). Only the conversion
 *     points are removed; the confidence component is preserved. NOTHING else is
 *     touched — no status, gradingStatus, W/L, ROI, or any other column/table.
 *
 * Run (dry-run):  npx tsx server/scripts/cleanupPollutedHrRadarConversion.ts
 * Run (apply):    npx tsx server/scripts/cleanupPollutedHrRadarConversion.ts --apply
 * Run (date):     npx tsx server/scripts/cleanupPollutedHrRadarConversion.ts --date=2026-06-25 --apply
 */
import { writeFileSync } from "fs";
import { resolve } from "path";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../db";
import { hrRadarAlerts } from "../../shared/schema";
import { todayET } from "../utils/dateUtils";
import { EMPIRICAL_CALIBRATION_CEILING } from "../mlb/hrConversionModel";

const TAG = "[HR_RADAR_CLEANUP]";

function parseArgs(argv: string[]): { apply: boolean; date: string } {
  const apply = argv.includes("--apply");
  const dateArg = argv.find(a => a.startsWith("--date="));
  const date = dateArg ? dateArg.slice("--date=".length) : todayET();
  return { apply, date };
}

/** Pull a finite number out of a loosely-typed jsonb field, else null. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Parse a numeric (string|number|null) DB column into a finite number, else null. */
function col(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

// Engine readiness formula (hrAlertEngine): conversionPts = clamp(conv*60, 0, 60),
// added on top of confidence points (which stay fully engaged for any conv above
// the PREPARE threshold). Backing out exactly (oldConvPts - newConvPts) removes the
// conversion-driven inflation while preserving the confidence component. Conservative
// on rows that hit the 100 clamp (suppresses slightly more, never inflates).
const convPts = (p: number): number => Math.max(0, Math.min(60, p * 60));
function backOutReadiness(oldReadiness: number, oldConv: number, newConv: number): number {
  const delta = convPts(oldConv) - convPts(newConv);
  return Math.max(0, Math.round(oldReadiness - delta));
}

async function main() {
  const { apply, date } = parseArgs(process.argv.slice(2));
  console.log(
    `${TAG} start mode=${apply ? "APPLY" : "DRY-RUN"} session=${date} ` +
    `ceiling=${EMPIRICAL_CALIBRATION_CEILING}`,
  );

  // ACTIVE-ONLY guard: status='live' AND gradingStatus='active' AND not resolved.
  // This intentionally excludes every row that feeds the official W/L / ROI ledger.
  const rows = await db
    .select()
    .from(hrRadarAlerts)
    .where(
      and(
        eq(hrRadarAlerts.sessionDate, date),
        eq(hrRadarAlerts.status, "live"),
        eq(hrRadarAlerts.gradingStatus, "active"),
        ne(hrRadarAlerts.status, "hit"),
        ne(hrRadarAlerts.status, "miss"),
      ),
    );

  console.log(`${TAG} scanned ${rows.length} active rows for session=${date}`);

  type Affected = {
    id: string;
    playerId: string;
    playerName: string;
    gameId: string;
    oldConversionProbability: number | null;
    oldPeakConversionProbability: number | null;
    newConversionProbability: number | null;
    newPeakConversionProbability: number | null;
    oldCurrentReadinessScore: number | null;
    oldPeakReadinessScore: number | null;
    newCurrentReadinessScore: number | null;
    newPeakReadinessScore: number | null;
    diagnosticsSnapshot: unknown; // full pre-change snapshot for restore
  };

  const affected: Affected[] = [];

  for (const row of rows) {
    const diag = (row.diagnosticsSnapshot ?? {}) as Record<string, any>;
    const sc = diag.scoreContract;
    if (!sc || typeof sc !== "object") continue;

    const conv = num(sc.conversionProbability);
    const peak = num(sc.peakConversionProbability);
    const convPolluted = conv != null && conv > EMPIRICAL_CALIBRATION_CEILING;
    const peakPolluted = peak != null && peak > EMPIRICAL_CALIBRATION_CEILING;
    if (!convPolluted && !peakPolluted) continue;

    const newConv = convPolluted ? EMPIRICAL_CALIBRATION_CEILING : conv;
    const newPeak = peakPolluted ? EMPIRICAL_CALIBRATION_CEILING : peak;

    // Back the conversion inflation out of the readiness columns the board sorts by.
    const curRead = col(row.currentReadinessScore);
    const peakRead = col(row.peakReadinessScore);
    const newCurRead =
      convPolluted && curRead != null && conv != null
        ? backOutReadiness(curRead, conv, newConv as number)
        : curRead;
    const newPeakRead =
      peakPolluted && peakRead != null && peak != null
        ? backOutReadiness(peakRead, peak, newPeak as number)
        : peakRead;

    affected.push({
      id: row.id,
      playerId: row.playerId,
      playerName: row.playerName,
      gameId: row.gameId,
      oldConversionProbability: conv,
      oldPeakConversionProbability: peak,
      newConversionProbability: newConv,
      newPeakConversionProbability: newPeak,
      oldCurrentReadinessScore: curRead,
      oldPeakReadinessScore: peakRead,
      newCurrentReadinessScore: newCurRead,
      newPeakReadinessScore: newPeakRead,
      diagnosticsSnapshot: row.diagnosticsSnapshot,
    });

    console.log(
      `${TAG} POLLUTED ` +
      `player="${row.playerName}" (${row.playerId}) game=${row.gameId} ` +
      `conv ${conv ?? "—"} → ${newConv ?? "—"} | ` +
      `peak ${peak ?? "—"} → ${newPeak ?? "—"} | ` +
      `readiness ${curRead ?? "—"} → ${newCurRead ?? "—"} | ` +
      `peakReadiness ${peakRead ?? "—"} → ${newPeakRead ?? "—"} | ` +
      `action=${apply ? "clamp(suppress)" : "WOULD clamp(suppress) [dry-run]"}`,
    );
  }

  console.log(`${TAG} polluted=${affected.length} of scanned=${rows.length}`);

  if (affected.length === 0) {
    console.log(`${TAG} nothing to do — no active polluted rows. exiting clean.`);
    process.exit(0);
  }

  // SNAPSHOT-FIRST — always write the backup (even in dry-run) before any mutation.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = resolve(process.cwd(), `hr-radar-cleanup-snapshot-${date}-${stamp}.json`);
  writeFileSync(
    backupPath,
    JSON.stringify(
      { tag: TAG, session: date, ceiling: EMPIRICAL_CALIBRATION_CEILING, mode: apply ? "apply" : "dry-run", capturedAt: stamp, rows: affected },
      null,
      2,
    ),
  );
  console.log(`${TAG} snapshot of ${affected.length} affected rows → ${backupPath}`);

  if (!apply) {
    console.log(`${TAG} DRY-RUN complete — no rows changed. Re-run with --apply to write.`);
    process.exit(0);
  }

  let updated = 0;
  let errored = 0;
  for (const a of affected) {
    try {
      const diag = { ...(a.diagnosticsSnapshot as Record<string, any>) };
      const sc = { ...(diag.scoreContract as Record<string, any>) };
      if (a.newConversionProbability != null) sc.conversionProbability = a.newConversionProbability;
      if (a.newPeakConversionProbability != null) sc.peakConversionProbability = a.newPeakConversionProbability;
      diag.scoreContract = sc;

      // ONLY diagnosticsSnapshot + the two readiness display/sort columns are
      // touched — no status / gradingStatus / W-L / ROI. (numeric columns take strings)
      const setObj: Record<string, unknown> = { diagnosticsSnapshot: diag };
      if (a.newCurrentReadinessScore != null && a.newCurrentReadinessScore !== a.oldCurrentReadinessScore) {
        setObj.currentReadinessScore = String(a.newCurrentReadinessScore);
      }
      if (a.newPeakReadinessScore != null && a.newPeakReadinessScore !== a.oldPeakReadinessScore) {
        setObj.peakReadinessScore = String(a.newPeakReadinessScore);
      }
      await db.update(hrRadarAlerts).set(setObj).where(eq(hrRadarAlerts.id, a.id));
      updated++;
      console.log(
        `${TAG} APPLIED player="${a.playerName}" (${a.playerId}) game=${a.gameId} ` +
        `conv→${a.newConversionProbability} peak→${a.newPeakConversionProbability} ` +
        `readiness→${a.newCurrentReadinessScore} peakReadiness→${a.newPeakReadinessScore}`,
      );
    } catch (err: any) {
      errored++;
      console.warn(`${TAG} FAILED id=${a.id} player="${a.playerName}" err=${err?.message ?? err}`);
    }
  }

  console.log(`${TAG} DONE — updated=${updated} errored=${errored} backup=${backupPath}`);
  process.exit(errored > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`${TAG} FATAL:`, err);
  process.exit(1);
});
