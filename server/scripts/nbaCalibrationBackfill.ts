// One-shot backfill: tag pre-nba-calibration-v2 NBA plays.
//
// Run: `npx tsx server/scripts/nbaCalibrationBackfill.ts`
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
import { and, asc, eq, isNotNull, lt, sql } from "drizzle-orm";

// ── Cutover boundary ─────────────────────────────────────────────────────────
// Default: 2026-04-01 UTC. Adjust to the actual deploy date of the finalizer.
const AUDIT_V2_CUTOVER_AT: Date = process.env.NBA_CAL_CUTOVER_ISO
  ? new Date(process.env.NBA_CAL_CUTOVER_ISO)
  : new Date("2026-04-01T00:00:00.000Z");

if (isNaN(AUDIT_V2_CUTOVER_AT.getTime())) {
  console.error(
    "[NBA_CAL_BACKFILL] Invalid cutover date. Set NBA_CAL_CUTOVER_ISO to a valid ISO 8601 string.",
  );
  process.exit(1);
}

const PRE_V2_TAG = "pre-nbaCalV2";
const V2_TOKEN = "nbaCalV2";
const BATCH = 2_000;

async function main() {
  console.log(
    `[NBA_CAL_BACKFILL] Starting pre-nbaCalV2 backfill (cutover=${AUDIT_V2_CUTOVER_AT.toISOString()})…`,
  );

  let lastCreatedAt: Date | null = null;
  let lastId: string | null = null;
  let totalTagged = 0;
  let totalSkipped = 0;

  while (true) {
    // Keyset pagination: ordered by (createdAt ASC, id ASC), filtered by
    // the cutover boundary so we never touch post-deploy plays.
    const conditions = [
      eq(persistedPlays.sport, "nba"),
      isNotNull(persistedPlays.result),
      lt(persistedPlays.createdAt, AUDIT_V2_CUTOVER_AT),
    ];

    if (lastCreatedAt !== null && lastId !== null) {
      // Continue after the last seen (createdAt, id) pair.
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

    // Advance keyset cursor.
    const last = rows[rows.length - 1];
    lastCreatedAt = last.createdAt;
    lastId = last.id;

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
      // Prepend pre-nbaCalV2 to the existing track (or set it when null/empty).
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
        .where(sql`${persistedPlays.id} = ANY(${toTag})`);

      totalTagged += toTag.length;
      console.log(
        `[NBA_CAL_BACKFILL] batch cursor=${lastCreatedAt?.toISOString()} tagged=${toTag.length} total=${totalTagged}`,
      );
    }

    if (rows.length < BATCH) break;
  }

  console.log(
    `[NBA_CAL_BACKFILL] DONE — cutover=${AUDIT_V2_CUTOVER_AT.toISOString()} tagged=${totalTagged} skipped_already_classified=${totalSkipped}`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[NBA_CAL_BACKFILL] FATAL:", err);
  process.exit(1);
});
