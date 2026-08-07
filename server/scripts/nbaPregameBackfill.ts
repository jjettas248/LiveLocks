// PR5 — NBA pregame ingestion: EXPLICIT manual backfill runner.
//
// Run: NBA_PREGAME_INGEST_ENABLED=true npx tsx server/scripts/nbaPregameBackfill.ts \
//        --confirm --players 201939,2544 --seasons 2025-26,2024-25,2023-24
//
// This is the ONLY way ingestion runs. It is a standalone script — it is NOT
// imported by server/index.ts and NEVER executes at server startup, on a cron, or
// via a route. Execution additionally requires BOTH the fail-closed flag
// (NBA_PREGAME_INGEST_ENABLED) AND an explicit `--confirm` argument; the flag is
// not a substitute for explicit invocation.
//
// Storage is imported LAZILY inside main() so this module can be typechecked
// without a DATABASE_URL. In this sandbox (no DB, no NBA Stats access) the runner
// cannot perform a live pull — that is deferred to the authorized environment; see
// docs/pregame-targets/PR5-source-manifest.md.

import { getPlayerGameLogs, resolveGameLogSeason, type PlayerGameLogRow } from "../services/nbaStatsService";
import { nbaSeasonIntFromString } from "../pregameTargets/ingestion/nbaGameLogAdapter";
import { isNbaIngestEnabled } from "../pregameTargets/ingestion/nbaIngestionFlags";
import { ingestPlayerSeason, type GameLogFetcher, type IngestionStorePort } from "../pregameTargets/ingestion/nbaIngestionJob";
import { NBA_FEATURE_VERSION } from "../pregameTargets/ingestion/nbaFeatureBuilder";
import type { PosteriorState } from "../pregameTargets/posteriorState/posteriorState";

/** Reconstruct a provider-shaped `{ resultSets }` payload from normalized rows. */
function rowsToRawPayload(rows: PlayerGameLogRow[]): unknown {
  const headers = ["GAME_ID", "GAME_DATE", "MATCHUP", "MIN", "PTS", "REB", "AST", "FG3M"];
  const rowSet = rows.map((r) => [r.GAME_ID, r.GAME_DATE, r.MATCHUP, r.MIN, r.PTS, r.REB ?? null, r.AST ?? null, r.FG3M ?? null]);
  return { resultSets: [{ headers, rowSet }] };
}

/** Build the ingestion store port from a storage instance (IStorage-shaped). */
export function buildStorePort(storage: {
  getPregameRawSourceSnapshot(id: string): Promise<{ snapshotId: string } | null>;
  getPregamePosteriorState(entity: string, featureKey: string, featureVersion: string): Promise<{ stateVersion: number; bySeason: unknown } | null>;
  ingestPregameNbaSnapshotAtomic(args: never): Promise<{ inserted: boolean }>;
}): IngestionStorePort {
  return {
    getRawSnapshotById: (id) => storage.getPregameRawSourceSnapshot(id),
    getPosterior: async (entity, featureKey, featureVersion) => {
      const r = await storage.getPregamePosteriorState(entity, featureKey, featureVersion);
      if (!r) return null;
      const state: PosteriorState = {
        version: r.stateVersion,
        featureKey,
        featureVersion,
        entityCanonicalId: entity,
        bySeason: (r.bySeason ?? {}) as PosteriorState["bySeason"],
      };
      return state;
    },
    ingestSnapshotAtomic: (args) => storage.ingestPregameNbaSnapshotAtomic(args as never),
  };
}

function parseListArg(argv: string[], name: string): string[] {
  const i = argv.indexOf(name);
  if (i === -1 || i + 1 >= argv.length) return [];
  return argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (!isNbaIngestEnabled()) {
    console.error("[NBA_INGEST] refused: NBA_PREGAME_INGEST_ENABLED is not set (fail-closed).");
    process.exit(2);
  }
  if (!argv.includes("--confirm")) {
    console.error("[NBA_INGEST] refused: explicit --confirm is required (the flag is not a substitute for explicit invocation).");
    process.exit(2);
  }
  const players = parseListArg(argv, "--players");
  const seasons = parseListArg(argv, "--seasons");
  const seasonType = parseListArg(argv, "--seasonType")[0] ?? "Regular Season";
  if (players.length === 0 || seasons.length === 0) {
    console.error("[NBA_INGEST] usage: --players <id,...> --seasons <YYYY-YY,...> [--seasonType 'Regular Season']");
    process.exit(2);
  }

  const { storage } = await import("../storage");
  const store = buildStorePort(storage as never);
  const currentSeason = nbaSeasonIntFromString(resolveGameLogSeason()) ?? new Date().getUTCFullYear();
  const asOfDate = new Date().toISOString();

  const fetcher: GameLogFetcher = async ({ entityNativeId, season }) => {
    const seasonStr = nbaSeasonStringForInt(season);
    const rows = await getPlayerGameLogs({ playerId: entityNativeId, season: seasonStr, limit: 200 });
    if (!rows || rows.length === 0) return null;
    return { rawPayload: rowsToRawPayload(rows), fetchedAt: new Date().toISOString() };
  };

  let failures = 0;
  for (const playerNativeId of players) {
    for (const seasonStr of seasons) {
      const seasonInt = nbaSeasonIntFromString(seasonStr);
      if (seasonInt === null) { console.error(`[NBA_INGEST] bad season "${seasonStr}"`); failures++; continue; }
      try {
        const outcome = await ingestPlayerSeason({ store, fetch: fetcher }, { playerNativeId, season: seasonInt, seasonType, currentSeason, asOfDate });
        if (outcome.status === "provider_failure" || outcome.status === "incomplete") failures++;
        console.log(`[NBA_INGEST] player=${playerNativeId} season=${seasonStr} status=${outcome.status} records=${outcome.recordCount} features=${outcome.featureRowsWritten} posteriors=${outcome.posteriorsUpdated.length} coverage=${outcome.coverage.coverage}/${outcome.coverage.knownAtSupport}`);
      } catch (err) {
        failures++;
        // A DB/write failure: log the message only — never the payload or connection string.
        console.error(`[NBA_INGEST] player=${playerNativeId} season=${seasonStr} ERROR: ${err instanceof Error ? err.message : "unknown"}`);
      }
    }
  }
  console.log(`[NBA_INGEST] done. featureVersion=${NBA_FEATURE_VERSION} failures=${failures}`);
  // A provider or database failure returns a nonzero exit code.
  if (failures > 0) process.exit(1);
}

function nbaSeasonStringForInt(seasonInt: number): string {
  const start = seasonInt - 1;
  return `${start}-${String(seasonInt % 100).padStart(2, "0")}`;
}

// Run only when invoked directly — never on import (no startup/cron/route wiring).
const invokedDirectly = process.argv[1] != null && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => { console.error("[NBA_INGEST] fatal:", err); process.exit(1); });
}
