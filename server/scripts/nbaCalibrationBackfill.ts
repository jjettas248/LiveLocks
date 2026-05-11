// One-shot backfill: tag pre-nba-calibration-v2 NBA plays.
//
// Run: `npx tsx server/scripts/nbaCalibrationBackfill.ts`
//
// Also invoked automatically once on server boot via
// `runNbaCalibrationBackfill()` so any plays ingested between deploy and a
// manual run still get classified. The first paginated query returns zero
// rows when everything is already tagged, so the boot path is a fast no-op.
//
// WHY THIS EXISTS
// ───────────────
// The nba-calibration-v2 finalizer stamps "+nbaCalV2:<capReason>" onto
// calibrationTrack ONLY when a cap fires. Plays created before the finalizer
// was deployed therefore have no nbaCalV2 token — and so do post-deploy plays
// where no cap was applied. Without a cutover boundary, these two groups are
// indistinguishable in the cohort report.
//
// This script adds the boundary: it stamps "pre-nbaCalV2" onto every settled
// NBA play whose createdAt is BEFORE AUDIT_V2_CUTOVER_AT (i.e. truly historical)
// and whose calibrationTrack does not already contain any v2 evidence.
//
// CUTOVER DATE
// ────────────
// Update AUDIT_V2_CUTOVER_AT to match the UTC timestamp when the
// nba-calibration-v2 finalizer first shipped to production. This value is used
// as the exclusive upper bound: plays with createdAt < cutover are historical.
//
// Override at runtime: NBA_CAL_CUTOVER_ISO=2026-04-15T00:00:00.000Z npx tsx ...
//
// IDEMPOTENT: re-running is a no-op on already-tagged rows (both v2-stamped
// and pre-nbaCalV2-stamped rows are skipped).

import { db } from "../db";
import { persistedPlays } from "@shared/schema";
import { and, asc, eq, inArray, isNotNull, lt, not, or, like, sql } from "drizzle-orm";
import { fileURLToPath } from "url";
import path from "path";

// ── Cutover boundary ─────────────────────────────────────────────────────────
// Default: 2026-04-01 UTC. Adjust to the actual deploy date of the finalizer.
const AUDIT_V2_CUTOVER_AT: Date = process.env.NBA_CAL_CUTOVER_ISO
  ? new Date(process.env.NBA_CAL_CUTOVER_ISO)
  : new Date("2026-04-01T00:00:00.000Z");

const PRE_V2_TAG = "pre-nbaCalV2";
const V2_TOKEN = "nbaCalV2";
const BATCH = 2_000;

export interface NbaCalibrationBackfillResult {
  tagged: number;
  skipped: number;
  cutover: string;
}

export async function runNbaCalibrationBackfill(opts: {
  verbose?: boolean;
} = {}): Promise<NbaCalibrationBackfillResult> {
  const verbose = opts.verbose ?? false;

  if (isNaN(AUDIT_V2_CUTOVER_AT.getTime())) {
    throw new Error(
      "[NBA_CAL_BACKFILL] Invalid cutover date. Set NBA_CAL_CUTOVER_ISO to a valid ISO 8601 string.",
    );
  }

  if (verbose) {
    console.log(
      `[NBA_CAL_BACKFILL] Starting pre-nbaCalV2 backfill (cutover=${AUDIT_V2_CUTOVER_AT.toISOString()})…`,
    );
  }

  // ── DB-level fast-path guard ──────────────────────────────────────
  // Skip the keyset loop entirely when no untagged rows exist. The
  // baseConditions filter mirrors the per-row check in JS land
  // (`!hasV2 && !alreadyTagged`) so a single `LIMIT 1` probe tells us
  // whether there is anything to do. When already complete this is a
  // single index scan in the low-ms range and the function returns
  // tagged=0 skipped=0 immediately — true ≈0ms boot path.
  const untaggedFilter = and(
    eq(persistedPlays.sport, "nba"),
    isNotNull(persistedPlays.result),
    lt(persistedPlays.createdAt, AUDIT_V2_CUTOVER_AT),
    or(
      sql`${persistedPlays.calibrationTrack} IS NULL`,
      and(
        not(like(persistedPlays.calibrationTrack, `%${V2_TOKEN}%`)),
        not(like(persistedPlays.calibrationTrack, `${PRE_V2_TAG}%`)),
      ),
    ),
  );

  const probe = await db
    .select({ id: persistedPlays.id })
    .from(persistedPlays)
    .where(untaggedFilter)
    .limit(1);

  if (probe.length === 0) {
    return {
      tagged: 0,
      skipped: 0,
      cutover: AUDIT_V2_CUTOVER_AT.toISOString(),
    };
  }

  let lastCreatedAt: Date | null = null;
  let lastId: string | null = null;
  let totalTagged = 0;
  let totalSkipped = 0;

  while (true) {
    // Keyset pagination: ordered by (createdAt ASC, id ASC), filtered by
    // the cutover boundary AND the untagged predicate so the loop only
    // ever sees rows that need work.
    const conditions = [untaggedFilter];

    if (lastCreatedAt !== null && lastId !== null) {
      conditions.push(
        sql`(${persistedPlays.createdAt}, ${persistedPlays.id}) > (${lastCreatedAt}, ${lastId})`,
      );
    }

    const rows = await db
      .select({
        id: persistedPlays.id,
        createdAt: persistedPlays.createdAt,
        calibrationTrack: persistedPlays.calibrationTrack,
      })
      .from(persistedPlays)
      .where(and(...conditions))
      .orderBy(asc(persistedPlays.createdAt), asc(persistedPlays.id))
      .limit(BATCH);

    if (rows.length === 0) break;

    const last = rows[rows.length - 1];
    lastCreatedAt = last.createdAt;
    lastId = last.id;

    // Defense-in-depth: the DB filter already excludes tagged rows, but
    // re-check in JS so a future filter regression can't double-tag.
    const toTag: string[] = [];
    for (const row of rows) {
      const track = row.calibrationTrack ?? "";
      const hasV2 = track.includes(V2_TOKEN);
      const alreadyTagged = track.startsWith(PRE_V2_TAG);
      if (!hasV2 && !alreadyTagged) {
        toTag.push(row.id);
      } else {
        totalSkipped++;
      }
    }

    if (toTag.length > 0) {
      await db
        .update(persistedPlays)
        .set({
          calibrationTrack: sql`
            CASE
              WHEN ${persistedPlays.calibrationTrack} IS NULL
                OR ${persistedPlays.calibrationTrack} = ''
              THEN ${PRE_V2_TAG}
              ELSE ${PRE_V2_TAG} || '+' || ${persistedPlays.calibrationTrack}
            END
          `,
        })
        .where(inArray(persistedPlays.id, toTag));

      totalTagged += toTag.length;
      if (verbose) {
        console.log(
          `[NBA_CAL_BACKFILL] batch cursor=${lastCreatedAt?.toISOString()} tagged=${toTag.length} total=${totalTagged}`,
        );
      }
    }

    if (rows.length < BATCH) break;
  }

  if (verbose) {
    console.log(
      `[NBA_CAL_BACKFILL] DONE — cutover=${AUDIT_V2_CUTOVER_AT.toISOString()} tagged=${totalTagged} skipped_already_classified=${totalSkipped}`,
    );
  }

  return {
    tagged: totalTagged,
    skipped: totalSkipped,
    cutover: AUDIT_V2_CUTOVER_AT.toISOString(),
  };
}

// CLI entrypoint: only run when invoked directly via `npx tsx`. Compare
// normalized absolute paths so relative-vs-absolute argv invocations
// (e.g. `tsx ./server/scripts/...`) still match the module URL.
function isDirectCliInvocation(): boolean {
  const argv1 = process.argv[1];
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  try {
    const moduleAbs = path.resolve(fileURLToPath(import.meta.url));
    const argvAbs = path.resolve(argv1);
    return moduleAbs === argvAbs;
  } catch {
    return false;
  }
}

const isDirectInvocation = isDirectCliInvocation();

if (isDirectInvocation) {
  runNbaCalibrationBackfill({ verbose: true })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[NBA_CAL_BACKFILL] FATAL:", err);
      process.exit(1);
    });
}
