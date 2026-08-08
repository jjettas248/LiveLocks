// PR6 — NFL pregame ingestion: EXPLICIT manual backfill runner.
//
// Run: NFL_PREGAME_INGEST_ENABLED=true npx tsx server/scripts/nflPregameBackfill.ts \
//        --confirm --seasons 2024,2023,2022
//
// This is the ONLY way NFL ingestion runs. It is a standalone script — NOT imported by
// server/index.ts and NEVER executes at server startup, on a cron, or via a route.
// Execution additionally requires BOTH the fail-closed flag (NFL_PREGAME_INGEST_ENABLED)
// AND an explicit `--confirm` argument.
//
// Production use of NFL ingestion is PENDING OWNER CONFIRMATION (nflverse licensing) — see
// docs/pregame-targets/PR6-nfl-source-manifest.md. Storage is imported LAZILY inside
// main(), only AFTER all args validate, so a bad argument never touches storage/provider,
// and the module typechecks without a DATABASE_URL. This environment has no nflverse
// access — a live pull is deferred to the authorized environment.

import { fetchRawNflverseCsv, weeklyStatsUrl, schedulesUrl } from "../pregameTargets/ingestion/nfl/nflverseProvider";
import { isNflIngestEnabled } from "../pregameTargets/ingestion/nfl/nflIngestionFlags";
import { ingestNflSeason, NflIngestInvocationError, type CsvFetcher, type NflIngestionStorePort } from "../pregameTargets/ingestion/nfl/nflIngestionJob";
import { buildNflIngestErrorRecord } from "../pregameTargets/ingestion/nfl/nflIngestionErrors";

export function buildStorePort(storage: {
  ingestPregameDatasetSnapshotAtomic(args: unknown): Promise<{ decision: string; snapshotId: string | null; supersedes: string | null }>;
}): NflIngestionStorePort {
  return { ingestDatasetSnapshotAtomic: (args) => storage.ingestPregameDatasetSnapshotAtomic(args as never) as never };
}

function parseListArg(argv: string[], name: string): string[] {
  const i = argv.indexOf(name);
  if (i === -1 || i + 1 >= argv.length) return [];
  return argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (!isNflIngestEnabled()) {
    console.error("[NFL_INGEST] refused: NFL_PREGAME_INGEST_ENABLED is not set (fail-closed).");
    process.exit(2);
  }
  if (!argv.includes("--confirm")) {
    console.error("[NFL_INGEST] refused: explicit --confirm is required (the flag is not a substitute for explicit invocation).");
    process.exit(2);
  }
  const seasonStrs = parseListArg(argv, "--seasons");
  if (seasonStrs.length === 0) {
    console.error("[NFL_INGEST] usage: --seasons <YYYY,...>");
    process.exit(2);
  }
  const seasons: number[] = [];
  for (const s of seasonStrs) {
    const n = Number(s);
    if (!Number.isInteger(n) || n <= 1900 || n > 2100) { console.error(`[NFL_INGEST] refused: invalid --seasons entry "${s}".`); process.exit(2); }
    seasons.push(n);
  }

  const { storage } = await import("../storage");
  const store = buildStorePort(storage as never);
  const currentSeason = Math.max(...seasons);
  const asOfDate = new Date().toISOString();

  const fetchWeekly: CsvFetcher = async ({ season }) => {
    const res = await fetchRawNflverseCsv({ url: weeklyStatsUrl(season) });
    return res.ok ? { ok: true, rawCsv: res.rawCsv, fetchedAt: res.fetchedAt, sourcePublishedAt: res.sourcePublishedAt } : { ok: false, reason: res.reason, failedAt: res.failedAt };
  };
  const fetchSchedule: CsvFetcher = async () => {
    const res = await fetchRawNflverseCsv({ url: schedulesUrl() });
    return res.ok ? { ok: true, rawCsv: res.rawCsv, fetchedAt: res.fetchedAt, sourcePublishedAt: res.sourcePublishedAt } : { ok: false, reason: res.reason, failedAt: res.failedAt };
  };

  let failures = 0;
  for (const season of seasons) {
    try {
      const out = await ingestNflSeason({ store, fetchSchedule, fetchWeekly }, { season, currentSeason, asOfDate });
      if (out.status.startsWith("provider_failure") || out.status.startsWith("incomplete") || out.status === "unresolvable" || out.status === "conflicting_observation") failures++;
      const c = out.coverage?.counts;
      console.log(`[NFL_INGEST] season=${season} status=${out.status} accepted=${c?.structurallyAcceptedWeeklyRows ?? 0} resolved=${c?.scheduleResolvedRows ?? 0} unresolved=${c?.unresolvedGameIds ?? 0} features=${out.featureRowsWritten} players=${out.playersUpdated} rawCaptures=${c?.rawCapturesPersisted ?? 0} coverage=${out.coverage?.coverage ?? "n/a"}/${out.coverage?.knownAtSupport ?? "n/a"}`);
    } catch (err) {
      if (err instanceof NflIngestInvocationError) {
        console.error(`[NFL_INGEST] refused: invalid invocation (${err.kind}) for season=${season}.`);
        process.exit(2);
      }
      failures++;
      const rec = buildNflIngestErrorRecord({ stage: "persist", season: String(season), err });
      console.error(`[NFL_INGEST] FAILURE ${JSON.stringify(rec)}`);
    }
  }
  console.log(`[NFL_INGEST] done. featureVersion=nfl_nflverse_v1 failures=${failures}`);
  if (failures > 0) process.exit(1);
}

const invokedDirectly = process.argv[1] != null && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    const rec = buildNflIngestErrorRecord({ stage: "unknown", season: "*", err });
    console.error(`[NFL_INGEST] fatal ${JSON.stringify(rec)}`);
    process.exit(1);
  });
}
