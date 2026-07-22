// Pre-Game Power Radar — persistence adapter (Phase 2).
//
// Bridges the pure build module to storage. Imports storage here (NOT in the
// build/scoring modules) so the engine stays storage-free and unit-testable.
// Installs the build sink (persist all evaluated rows + manifest) and the DB
// fallback loader (reconstruct a snapshot from the latest persisted build).

import { storage } from "../../storage";
import type {
  InsertPregamePowerRadarSignal,
  PregamePowerRadarSignalRow,
} from "@shared/schema";
import type { PregameLineupStatus, PregamePowerSignal, PregameMarketSetup } from "./types";
import { marketSetupLabel } from "./marketTagger";
import { ATTACK_ENVIRONMENT_HOSTILE_SUPPRESSION_REASON } from "./attackEnvironment";

/**
 * Rows persisted before the `confirmed`/`projected`/`unconfirmed` → `posted`/
 * `unposted` rename still carry the old text values in the DB. Normalize on
 * read so historical rows deserialize correctly without a backfill migration.
 * `raw` is `unknown`, not `string` — the column is `text`, but a row read can
 * legitimately hand back `null` or a stray value the TypeScript row type does
 * not guarantee at runtime.
 */
function normalizeLegacyLineupStatus(raw: unknown): PregameLineupStatus {
  switch (raw) {
    case "posted":
    case "unposted":
      return raw;
    case "confirmed":
      return "posted";
    case "projected":
    case "unconfirmed":
      return "unposted";
    default:
      return "unposted"; // null/malformed/unrecognized — fail safe to the non-posted state
  }
}
import { setPregameBuildSink } from "./buildPregamePowerRadar";
import { setDbFallback } from "./pregamePowerRadarService";
import type { PregamePowerSnapshot } from "./pregamePowerRadarStore";

export function signalToRow(s: PregamePowerSignal): InsertPregamePowerRadarSignal {
  return {
    signalId: s.signalId,
    buildId: s.buildId,
    sessionDate: s.sessionDate,
    gameId: s.gameId,
    gameDate: s.gameDate,
    startsAt: s.startsAt ?? null,
    gameStatus: s.gameStatus,
    firstPitchLockEligible: s.firstPitchLockEligible,
    batterId: s.batterId,
    batterName: s.batterName,
    team: s.team,
    opponent: s.opponent,
    pitcherId: s.pitcherId ?? null,
    pitcherName: s.pitcherName ?? null,
    battingOrderSlot: s.battingOrderSlot ?? null,
    primaryMarket: s.primaryMarket,
    marketTags: s.marketTags,
    marketScores: s.marketScores,
    score10: String(s.score10),
    tier: s.tier,
    drivers: s.drivers,
    warnings: s.warnings,
    diagnostics: s.diagnostics,
    lineupStatus: s.lineupStatus,
    weatherStatus: s.weatherStatus,
    hasMarketLine: s.hasMarketLine,
    isOfficialPlay: s.isOfficialPlay,
    isPregameTarget: s.isPregameTarget,
    status: s.status,
    suppressed: s.suppressed,
    suppressedReasons: s.suppressedReasons,
    outcomes: s.outcomes ?? null,
    everPubliclyFlagged: s.everPubliclyFlagged,
    everAttackEnvironmentSuppressed: s.everAttackEnvironmentSuppressed,
    attackEnvironmentSuppressedScore10:
      s.attackEnvironmentSuppressedScore10 != null ? String(s.attackEnvironmentSuppressedScore10) : null,
    becameLiveReady: s.becameLiveReady,
    becameLiveFire: s.becameLiveFire,
    convertedLiveAt: s.convertedLiveAt ? new Date(s.convertedLiveAt) : null,
    lockedAt: s.lockedAt ? new Date(s.lockedAt) : null,
    gradedAt: null,
  };
}

export function rowToSignal(r: PregamePowerRadarSignalRow): PregamePowerSignal {
  // marketSetups are reconstructed from the *persisted* marketScores — honest,
  // not fabricated. Park/weather context is NOT persisted, so parkContext is null
  // here (the UI shows "Park context unavailable" rather than faking neutral).
  const primaryMarket = r.primaryMarket as PregamePowerSignal["primaryMarket"];
  const marketTags = (r.marketTags as PregamePowerSignal["marketTags"]) ?? [];
  const marketScores = (r.marketScores as PregamePowerSignal["marketScores"]) ?? {};
  const marketSetups: PregameMarketSetup[] = marketTags.map((market) => {
    const setupScore = marketScores[market] ?? 0;
    return { market, setupScore, setupLabel: marketSetupLabel(setupScore), isPrimary: market === primaryMarket };
  });
  return {
    signalId: r.signalId,
    sport: "mlb",
    engine: "pregame_power_radar",
    sessionDate: r.sessionDate,
    gameId: r.gameId,
    gameDate: r.gameDate,
    startsAt: r.startsAt ?? null,
    generatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : "",
    buildId: r.buildId,
    batterId: r.batterId,
    batterName: r.batterName,
    team: r.team,
    opponent: r.opponent,
    pitcherId: r.pitcherId ?? null,
    pitcherName: r.pitcherName ?? null,
    battingOrderSlot: r.battingOrderSlot ?? null,
    handednessMatchup: null,
    primaryMarket,
    marketTags,
    marketScores,
    marketSetups,
    parkContext: null,
    score10: typeof r.score10 === "string" ? parseFloat(r.score10) : (r.score10 as number),
    tier: r.tier as PregamePowerSignal["tier"],
    drivers: (r.drivers as PregamePowerSignal["drivers"]) ?? [],
    warnings: (r.warnings as string[]) ?? [],
    tags: [],
    lineupStatus: normalizeLegacyLineupStatus(r.lineupStatus),
    weatherStatus: r.weatherStatus as PregamePowerSignal["weatherStatus"],
    gameStatus: r.gameStatus as PregamePowerSignal["gameStatus"],
    firstPitchLockEligible: r.firstPitchLockEligible,
    lockedAt: r.lockedAt ? new Date(r.lockedAt).toISOString() : null,
    hasMarketLine: r.hasMarketLine,
    isOfficialPlay: false,
    isPregameTarget: true,
    status: r.status as PregamePowerSignal["status"],
    suppressed: r.suppressed,
    suppressedReasons: (r.suppressedReasons as string[]) ?? [],
    outcomes: (r.outcomes as PregamePowerSignal["outcomes"]) ?? null,
    everPubliclyFlagged: r.everPubliclyFlagged,
    // Read from the dedicated persisted column — durable across restarts,
    // same discipline as everPubliclyFlagged above (carryForwardGradedState
    // ORs it forward on every in-memory rebuild; this column is what survives
    // a full process restart). Column is NOT NULL DEFAULT false, so this is
    // never ambiguous even for rows written before this column existed.
    everAttackEnvironmentSuppressed: r.everAttackEnvironmentSuppressed,
    // Numeric column is nullable (no suppression → no snapshot); fall back to
    // deriving from suppressedReasons/score10 only for the edge case of a row
    // written between this column's migration landing and this read path
    // being deployed — never needed in ordinary operation.
    attackEnvironmentSuppressedScore10:
      r.attackEnvironmentSuppressedScore10 != null
        ? typeof r.attackEnvironmentSuppressedScore10 === "string"
          ? parseFloat(r.attackEnvironmentSuppressedScore10)
          : (r.attackEnvironmentSuppressedScore10 as number)
        : ((r.suppressedReasons as string[]) ?? []).includes(ATTACK_ENVIRONMENT_HOSTILE_SUPPRESSION_REASON)
          ? (typeof r.score10 === "string" ? parseFloat(r.score10) : (r.score10 as number))
          : null,
    becameLiveReady: r.becameLiveReady,
    becameLiveFire: r.becameLiveFire,
    convertedLiveAt: r.convertedLiveAt ? new Date(r.convertedLiveAt).toISOString() : null,
    diagnostics: r.diagnostics as PregamePowerSignal["diagnostics"],
  };
}

/** Best-effort historical loader used by pregame attribution stats. */
export async function loadPregameSignalsForDate(sessionDate: string): Promise<PregamePowerSignal[]> {
  try {
    const rows = await storage.getPregamePowerRadarSignalsByDate(sessionDate);
    return rows.map(rowToSignal);
  } catch (err: any) {
    console.warn(`[PREGAME_POWER_RADAR_DB_LOAD] failed date=${sessionDate}:`, err?.message ?? err);
    return [];
  }
}

let installed = false;

/**
 * Reconstruct a snapshot from the latest persisted build for `sessionDate`.
 * Extracted as its own named function (rather than only living inline as the
 * `setDbFallback` callback) so a boot-time hydration hook (server/index.ts)
 * can call the exact same reconstruction eagerly, instead of only reactively
 * inside getRadarSnapshot()'s stale-rebuild-failed branch.
 */
export async function loadPregameSnapshotFromDb(sessionDate: string): Promise<PregamePowerSnapshot | null> {
  const build = await storage.getLatestPregamePowerBuild(sessionDate);
  if (!build) return null;
  const rows = await storage.getPregamePowerRadarSignalsByDate(sessionDate);
  const buildRows = rows.filter((r) => r.buildId === build.buildId);
  if (buildRows.length === 0) return null;
  const signals = new Map<string, PregamePowerSignal>();
  for (const r of buildRows) signals.set(r.signalId, rowToSignal(r));
  return {
    buildId: build.buildId,
    sessionDate,
    generatedAt: build.completedAt ?? build.startedAt,
    builtAtMs: build.completedAt ? Date.parse(build.completedAt) : Date.now(),
    gamesScanned: build.gamesScanned,
    battersEvaluated: build.battersEvaluated,
    signals,
    coverage: {
      lineupCoverage: build.lineupCoverage ? parseFloat(build.lineupCoverage) : 0,
      weatherCoverage: build.weatherCoverage ? parseFloat(build.weatherCoverage) : 0,
      batterCoverage: build.batterCoverage ? parseFloat(build.batterCoverage) : 0,
      pitcherCoverage: build.pitcherCoverage ? parseFloat(build.pitcherCoverage) : 0,
    },
  };
}

/** Wire the build sink + DB fallback. Idempotent. */
export function installPregamePersistence(): void {
  if (installed) return;
  installed = true;

  setPregameBuildSink(async (signals, manifest) => {
    for (const s of signals) {
      await storage.upsertPregamePowerRadarSignal(signalToRow(s));
    }
    await storage.recordPregamePowerBuild({
      buildId: manifest.buildId,
      sessionDate: manifest.sessionDate,
      startedAt: manifest.startedAt,
      completedAt: manifest.completedAt,
      gamesScanned: manifest.gamesScanned,
      battersEvaluated: manifest.battersEvaluated,
      lineupCoverage: String(manifest.lineupCoverage),
      weatherCoverage: String(manifest.weatherCoverage),
      batterCoverage: String(manifest.batterCoverage),
      pitcherCoverage: String(manifest.pitcherCoverage),
      signalsCreated: manifest.signalsCreated,
      suppressedCount: manifest.suppressedCount,
      status: "complete",
    });
    console.log(`[PREGAME_POWER_RADAR_DB_UPSERT] persisted ${signals.length} rows build=${manifest.buildId}`);
  });

  setDbFallback(loadPregameSnapshotFromDb);
}
