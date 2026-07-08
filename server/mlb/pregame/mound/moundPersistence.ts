// Mound Radar — persistence adapter.
//
// Bridges the pure build module to storage. Imports storage here (NOT in the
// build/scoring modules) so the engine stays storage-free and unit-testable.
// Mirrors pregamePowerRadar/pregamePersistence.ts's role for pitcher signals.

import { storage } from "../../../storage";
import type {
  InsertMlbMoundRadarSignal,
  MlbMoundRadarSignalRow,
} from "@shared/schema";
import type { MoundSignal, MoundMarketSetup } from "./types";
import { marketSetupLabel } from "./marketTagger";
import { setMoundBuildSink } from "./buildMlbMoundRadar";
import { setMoundDbFallback } from "./mlbMoundRadarService";
import type { MoundRadarSnapshot } from "./mlbMoundRadarStore";

export function signalToRow(s: MoundSignal): InsertMlbMoundRadarSignal {
  return {
    signalId: s.signalId,
    buildId: s.buildId,
    sessionDate: s.sessionDate,
    gameId: s.gameId,
    gameDate: s.gameDate,
    startsAt: s.startsAt ?? null,
    gameStatus: s.gameStatus,
    firstPitchLockEligible: s.firstPitchLockEligible,
    pitcherId: s.pitcherId,
    pitcherName: s.pitcherName,
    team: s.team,
    opponent: s.opponent,
    opposingLineupConfirmed: s.opposingLineupConfirmed,
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
    everPubliclyFlaggedFade: s.everPubliclyFlaggedFade,
    becameLiveReady: s.becameLiveReady,
    becameLiveFire: s.becameLiveFire,
    convertedLiveAt: s.convertedLiveAt ? new Date(s.convertedLiveAt) : null,
    lockedAt: s.lockedAt ? new Date(s.lockedAt) : null,
    gradedAt: null,
  };
}

export function rowToSignal(r: MlbMoundRadarSignalRow): MoundSignal {
  const primaryMarket = r.primaryMarket as MoundSignal["primaryMarket"];
  const marketTags = (r.marketTags as MoundSignal["marketTags"]) ?? [];
  const marketScores = (r.marketScores as MoundSignal["marketScores"]) ?? {};
  const marketSetups: MoundMarketSetup[] = marketTags.map((market) => {
    const setupScore = marketScores[market] ?? 0;
    return { market, setupScore, setupLabel: marketSetupLabel(setupScore), isPrimary: market === primaryMarket };
  });
  return {
    signalId: r.signalId,
    sport: "mlb",
    engine: "mound_radar",
    sessionDate: r.sessionDate,
    gameId: r.gameId,
    gameDate: r.gameDate,
    startsAt: r.startsAt ?? null,
    generatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : "",
    buildId: r.buildId,
    pitcherId: r.pitcherId,
    pitcherName: r.pitcherName,
    team: r.team,
    opponent: r.opponent,
    throws: null,
    opposingLineupConfirmed: r.opposingLineupConfirmed,
    opposingLineupLabel: null,
    primaryMarket,
    marketTags,
    marketScores,
    marketSetups,
    parkContext: null,
    score10: typeof r.score10 === "string" ? parseFloat(r.score10) : (r.score10 as number),
    tier: r.tier as MoundSignal["tier"],
    // Read back out of the persisted diagnostics blob (no dedicated column,
    // stamped once at build time — never re-derived here).
    moundDirection: (r.diagnostics as MoundSignal["diagnostics"] | null)?.moundDirection ?? null,
    drivers: (r.drivers as MoundSignal["drivers"]) ?? [],
    warnings: (r.warnings as string[]) ?? [],
    tags: [],
    lineupStatus: r.lineupStatus as MoundSignal["lineupStatus"],
    weatherStatus: r.weatherStatus as MoundSignal["weatherStatus"],
    gameStatus: r.gameStatus as MoundSignal["gameStatus"],
    firstPitchLockEligible: r.firstPitchLockEligible,
    lockedAt: r.lockedAt ? new Date(r.lockedAt).toISOString() : null,
    hasMarketLine: r.hasMarketLine,
    isOfficialPlay: false,
    isPregameTarget: true,
    status: r.status as MoundSignal["status"],
    suppressed: r.suppressed,
    suppressedReasons: (r.suppressedReasons as string[]) ?? [],
    outcomes: (r.outcomes as MoundSignal["outcomes"]) ?? null,
    everPubliclyFlagged: r.everPubliclyFlagged,
    becameLiveReady: r.becameLiveReady,
    becameLiveFire: r.becameLiveFire,
    convertedLiveAt: r.convertedLiveAt ? new Date(r.convertedLiveAt).toISOString() : null,
    diagnostics: r.diagnostics as MoundSignal["diagnostics"],
    everPubliclyFlaggedFade: r.everPubliclyFlaggedFade,
    // Not persisted (presentation-only, like Plate's marketEdgeContext) —
    // DB-reconstructed signals never have a live odds fetch/projection to
    // restore, so these stay null rather than fabricated.
    marketEdgeContext: null,
    projectedStrikeouts: null,
    matchupAdjustedStrikeouts: null,
  };
}

/** Best-effort historical loader used by mound attribution stats. */
export async function loadMoundSignalsForDate(sessionDate: string): Promise<MoundSignal[]> {
  try {
    const rows = await storage.getMlbMoundRadarSignalsByDate(sessionDate);
    return rows.map(rowToSignal);
  } catch (err: any) {
    console.warn(`[MLB_PREGAME_MOUND_TARGETS] DB load failed date=${sessionDate}:`, err?.message ?? err);
    return [];
  }
}

let installed = false;

/** Wire the build sink + DB fallback. Idempotent. */
export function installMoundPersistence(): void {
  if (installed) return;
  installed = true;

  setMoundBuildSink(async (signals, manifest) => {
    for (const s of signals) {
      await storage.upsertMlbMoundRadarSignal(signalToRow(s));
    }
    await storage.recordMlbMoundRadarBuild({
      buildId: manifest.buildId,
      sessionDate: manifest.sessionDate,
      startedAt: manifest.startedAt,
      completedAt: manifest.completedAt,
      gamesScanned: manifest.gamesScanned,
      pitchersEvaluated: manifest.pitchersEvaluated,
      starterCoverage: String(manifest.starterCoverage),
      weatherCoverage: String(manifest.weatherCoverage),
      pitcherCoverage: String(manifest.pitcherCoverage),
      lineupCoverage: String(manifest.lineupCoverage),
      signalsCreated: manifest.signalsCreated,
      suppressedCount: manifest.suppressedCount,
      status: "complete",
    });
    console.log(`[MLB_PREGAME_MOUND_TARGETS] DB upsert persisted ${signals.length} rows build=${manifest.buildId}`);
  });

  setMoundDbFallback(async (sessionDate): Promise<MoundRadarSnapshot | null> => {
    const build = await storage.getLatestMlbMoundRadarBuild(sessionDate);
    if (!build) return null;
    const rows = await storage.getMlbMoundRadarSignalsByDate(sessionDate);
    const buildRows = rows.filter((r) => r.buildId === build.buildId);
    if (buildRows.length === 0) return null;
    const signals = new Map<string, MoundSignal>();
    for (const r of buildRows) signals.set(r.signalId, rowToSignal(r));
    return {
      buildId: build.buildId,
      sessionDate,
      generatedAt: build.completedAt ?? build.startedAt,
      builtAtMs: build.completedAt ? Date.parse(build.completedAt) : Date.now(),
      gamesScanned: build.gamesScanned,
      pitchersEvaluated: build.pitchersEvaluated,
      signals,
      coverage: {
        starterCoverage: build.starterCoverage ? parseFloat(build.starterCoverage) : 0,
        weatherCoverage: build.weatherCoverage ? parseFloat(build.weatherCoverage) : 0,
        pitcherCoverage: build.pitcherCoverage ? parseFloat(build.pitcherCoverage) : 0,
        lineupCoverage: build.lineupCoverage ? parseFloat(build.lineupCoverage) : 0,
      },
    };
  });
}
