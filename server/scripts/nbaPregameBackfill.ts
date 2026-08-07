// PR5 — NBA pregame ingestion: EXPLICIT manual backfill runner.
//
// Run: NBA_PREGAME_INGEST_ENABLED=true npx tsx server/scripts/nbaPregameBackfill.ts \
//        --confirm --players 201939,2544 --seasons 2025-26,2024-25,2023-24 \
//        [--seasonType "Regular Season" | "Playoffs"]
//
// This is the ONLY way ingestion runs. It is a standalone script — it is NOT
// imported by server/index.ts and NEVER executes at server startup, on a cron, or
// via a route. Execution additionally requires BOTH the fail-closed flag
// (NBA_PREGAME_INGEST_ENABLED) AND an explicit `--confirm` argument.
//
// The runner fetches the RAW provider payload (verbatim JSON, original headers/cells,
// genuine nulls) and hands it straight to the ingestion adapter — it does NOT go
// through the presentation getPlayerGameLogs()/PlayerGameLogRow path, which drops
// metadata and coerces missing MIN/PTS to 0. The season string and season type it
// stores under are the exact ones it requested (identity == request).
//
// Storage is imported LAZILY inside main() — and only AFTER all CLI arguments are
// validated — so this module can be typechecked without a DATABASE_URL and a bad
// argument never touches storage or the provider. In this sandbox (no DB, no NBA
// Stats access) the runner cannot perform a live pull — deferred to the authorized
// environment; see docs/pregame-targets/PR5-source-manifest.md.

import {
  fetchRawNbaPlayerGameLog,
  resolveGameLogSeason,
} from "../services/nbaStatsService";
import { nbaSeasonIntFromString } from "../pregameTargets/ingestion/nbaGameLogAdapter";
import { isNbaIngestEnabled } from "../pregameTargets/ingestion/nbaIngestionFlags";
import { ingestPlayerSeason, IngestInvocationError, type GameLogFetcher, type IngestionStorePort } from "../pregameTargets/ingestion/nbaIngestionJob";
import { NBA_FEATURE_VERSION } from "../pregameTargets/ingestion/nbaFeatureBuilder";
import { buildIngestErrorRecord } from "../pregameTargets/ingestion/nbaIngestionErrors";
import { isNbaIngestSeasonType, NBA_SUPPORTED_SEASON_TYPES, type NbaIngestSeasonType } from "../pregameTargets/ingestion/nbaSourceContracts";
import type { PosteriorState } from "../pregameTargets/posteriorState/posteriorState";

/** Canonical season-type gate (single source of truth shared with the orchestrator). */
export function parseSeasonType(raw: string): NbaIngestSeasonType | null {
  return isNbaIngestSeasonType(raw) ? raw : null;
}

/** Build the ingestion store port from a storage instance (IStorage-shaped). */
export function buildStorePort(storage: {
  getPregameRawSourceSnapshot(id: string): Promise<{ snapshotId: string } | null>;
  ingestPregameNbaSnapshotAtomic(args: {
    entityCanonicalId: string;
    featureVersion: string;
    featureKeys: string[];
    raw: unknown;
    features: unknown[];
    foldPosteriors: (lockedPriors: Map<string, PosteriorState>) => unknown[];
  }): Promise<{ inserted: boolean }>;
}): IngestionStorePort {
  return {
    getRawSnapshotById: (id) => storage.getPregameRawSourceSnapshot(id),
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
  if (players.length === 0 || seasons.length === 0) {
    console.error("[NBA_INGEST] usage: --players <id,...> --seasons <YYYY-YY,...> [--seasonType 'Regular Season'|'Playoffs']");
    process.exit(2);
  }

  // ── Validate EVERY argument BEFORE importing storage or contacting the provider ──
  // Season type: restricted to the supported enum. An unsupported value is rejected
  // with exit 2 so we never fetch one season type and store under another's identity.
  const seasonTypeRaw = parseListArg(argv, "--seasonType")[0] ?? "Regular Season";
  const seasonType = parseSeasonType(seasonTypeRaw);
  if (seasonType === null) {
    console.error(`[NBA_INGEST] refused: unsupported --seasonType "${seasonTypeRaw}" (allowed: ${NBA_SUPPORTED_SEASON_TYPES.join(", ")}).`);
    process.exit(2);
  }
  // Seasons: the ONE canonical parser validates every season string semantically. A
  // structurally-shaped but invalid season is rejected here — never silently
  // normalized to a different season the caller did not request.
  const seasonPlan: Array<{ label: string; int: number }> = [];
  for (const label of seasons) {
    const int = nbaSeasonIntFromString(label);
    if (int === null) {
      console.error(`[NBA_INGEST] refused: invalid --seasons entry "${label}" (expected YYYY-YY with a coherent suffix, e.g. 2024-25).`);
      process.exit(2);
    }
    seasonPlan.push({ label, int });
  }

  const { storage } = await import("../storage");
  const store = buildStorePort(storage as never);
  const currentSeason = nbaSeasonIntFromString(resolveGameLogSeason()) ?? new Date().getUTCFullYear();
  const asOfDate = new Date().toISOString();

  // Fetcher: RAW provider payload, requested with the EXACT validated season LABEL
  // and season TYPE. Identity (what we store under) == request (what we fetched).
  const fetcher: GameLogFetcher = async ({ entityNativeId, seasonLabel }) => {
    const res = await fetchRawNbaPlayerGameLog({ playerId: entityNativeId, season: seasonLabel, seasonType });
    return res.ok
      ? { ok: true, rawPayload: res.rawPayload, requestedAt: res.requestedAt, fetchedAt: res.fetchedAt }
      : { ok: false, reason: res.reason, requestedAt: res.requestedAt, failedAt: res.failedAt };
  };

  let failures = 0;
  for (const playerNativeId of players) {
    for (const { label: seasonLabel, int: seasonInt } of seasonPlan) {
      try {
        const outcome = await ingestPlayerSeason(
          { store, fetch: fetcher },
          { playerNativeId, season: seasonInt, seasonLabel, seasonType, currentSeason, asOfDate },
        );
        if (outcome.status === "provider_failure" || outcome.status === "incomplete") failures++;
        console.log(`[NBA_INGEST] player=${playerNativeId} season=${seasonLabel} seasonType=${seasonType} status=${outcome.status} records=${outcome.recordCount} features=${outcome.featureRowsWritten} posteriors=${outcome.posteriorsUpdated.length} coverage=${outcome.coverage.coverage}/${outcome.coverage.knownAtSupport}`);
      } catch (err) {
        // A typed invocation error means an incoherent identity slipped past CLI
        // validation (a bug/bypass) — fail closed with exit 2, not a data-failure exit.
        if (err instanceof IngestInvocationError) {
          console.error(`[NBA_INGEST] refused: invalid invocation (${err.kind}) for player=${playerNativeId} season=${seasonLabel}.`);
          process.exit(2);
        }
        failures++;
        // Bounded, redacted record only — never the payload, connection string, SQL
        // parameters, auth headers, or a raw stack.
        const rec = buildIngestErrorRecord({ stage: "persist", playerId: playerNativeId, season: seasonLabel, seasonType, err });
        console.error(`[NBA_INGEST] FAILURE ${JSON.stringify(rec)}`);
      }
    }
  }
  console.log(`[NBA_INGEST] done. featureVersion=${NBA_FEATURE_VERSION} failures=${failures}`);
  // A provider or database failure returns a nonzero exit code.
  if (failures > 0) process.exit(1);
}

// Run only when invoked directly — never on import (no startup/cron/route wiring).
const invokedDirectly = process.argv[1] != null && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    // Even the fatal path stays bounded + redacted (never a raw object/stack).
    const rec = buildIngestErrorRecord({ stage: "unknown", playerId: "*", season: "*", seasonType: "*", err });
    console.error(`[NBA_INGEST] fatal ${JSON.stringify(rec)}`);
    process.exit(1);
  });
}
