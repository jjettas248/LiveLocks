import type { IStorage } from "../storage";
import { gradePersistedPlays } from "./gradePersistedPlays";
import { validateLiveSignalForDisplay } from "./validateLiveSignal";
import { nanoid } from "nanoid";
import { todayET } from "../utils/dateUtils";

export interface EngineDiagnostics {
  archetype?: string;
  fragilityScore?: number;
  fragilityPenalty?: number;
  fragilityReasons?: string[];
  familyId?: string;
  siblingCount?: number;
  siblingRank?: number;
  flagshipOrDerivative?: string;
  familyPenaltyFactor?: number;
  calibrationTrack?: string;
  confidenceCeilingApplied?: boolean;
  ceilingReason?: string;
  rawProbOver?: number;
  rawProbUnder?: number;
  finalProbOver?: number;
  finalProbUnder?: number;
  displayConfidence?: number;
  modelEdge?: number;
  minutesExpected?: number;
  minutesVariance?: number;
  marketType?: string;
  playerVolatilityScore?: number;
  comboCovarianceEstimate?: number | null;
  engineVersion?: string;
  mu?: number;
  sigma?: number;
  zScore?: number;
  // ── NBA Calibration v2 — finalizer telemetry (NBA-only) ─────────────────
  // Stamped by the NBA finalizer in storage.ts / probabilityEngine.ts so
  // the persisted play carries calibration provenance even though we don't
  // mint new DB columns. The route trackPlay whitelist forwards these
  // fields and the playTracker logs them via [NBA_CALIBRATION_V2_PERSIST]
  // so admin can grep persistence parity. The cap reason is also folded
  // into calibrationTrack as `+nbaCalV2:<reason>` for query-friendly use.
  calibrationVersion?: string;
  finalizerCapReason?: string | null;
  finalizerMarketRiskTier?: string;
  finalizerEliteGateApplied?: boolean;
  finalizerHighBucketCapped?: boolean;
  finalizerInitialPct?: number;
  finalizerFinalPct?: number;
  conflictingSideSuppressed?: boolean;
  conflictingSignalSuppressed?: boolean;
}

export interface TrackableSignal {
  gameId: string;
  playerId?: string | null;
  playerName: string;
  team?: string | null;
  sport: "nba" | "ncaab" | "mlb";
  market: string;
  direction: "over" | "under" | "cover" | "fade";
  line: number;
  projection: number;
  probability: number;
  // Legacy book-relative edge → `edge_gap` column (NBA/NCAAB). Optional: MLB no
  // longer populates it (see modelEdgePctPoints below), so new MLB rows leave
  // `edge_gap` null instead of the old invalid prob-50 value.
  edge?: number;
  sportsbook: string | null;
  derivedLine: boolean;
  createdAt: number;
  diagnostics?: EngineDiagnostics;
  odds?: number | null;
  signalScore?: number | null;
  confidenceTier?: string | null;
  inning?: number | null;
  abNumber?: number | null;
  pitchCount?: number | null;
  contactQualityScore?: number | null;
  opportunityScore?: number | null;
  liveScore?: number | null;
  eventBoost?: number | null;
  signalMode?: string | null;
  marketFamily?: string | null;
  // ── MLB Live Edge Trust Recovery (Phase 4) — official-episode provenance.
  // MLB-only; left undefined for NBA/NCAAB, which keep their existing
  // duplicateGuard-keyed upsert behavior untouched.
  playerIdForEpisode?: string | null;
  oddsSourceUpdatedAt?: number | null; // real sportsbook provider last_update
  oddsFetchedAt?: number | null; // LiveLocks cache/receipt time
  rawProbability?: number | null;
  officialEligibilityVersion?: string | null;
  officialEligibilityReasons?: string[] | null;
  dataQuality?: string | null;
  currentStatKnown?: boolean | null;
  calibrationVersion?: string | null;
  // ── MLB Live Edge safety-core (Stage A part 2) — canonical no-vig edge +
  // lane provenance. MLB-only. `modelEdgePctPoints` (percentage points) is the
  // canonical model edge and lands in the `model_edge` column; the legacy
  // `edge`→`edge_gap` mapping is left empty for MLB (it carried the invalid
  // prob-50 value before this change).
  modelEdgePctPoints?: number | null;
  noVigBookProbability?: number | null;
  edgeVersion?: string | null;
  probabilitySemantics?: string | null;
  lane?: string | null;
}

export async function trackPlay(
  signal: TrackableSignal,
  storage: IStorage
): Promise<{ id: string; isDuplicate: boolean }> {
  // [MLB Canonical Probability v1] MLB-specific persistence guard. Recommended-
  // side calibrated probability is the canonical wire & DB value. Reject if
  // missing/NaN/non-finite/out-of-range. signalScore is NEVER substituted.
  if (signal.sport === "mlb") {
    const p = signal.probability;
    const probValid = typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 100;
    if (!probValid) {
      console.warn("[MLB_PERSIST_REJECT]", {
        reason: "invalid_probability_at_persist",
        player: signal.playerName,
        market: signal.market,
        recommendedSide: signal.direction,
        probability: signal.probability,
        signalScore: signal.signalScore ?? null,
      });
      return { id: "", isDuplicate: true };
    }
    // MLB Live Edge Trust Recovery (Phase 4) — official episode identity
    // requires a stable playerId. No fallback to playerName: a missing
    // stable ID means we cannot guarantee episode uniqueness/immutability,
    // so official creation is rejected outright rather than keyed loosely.
    if (!signal.playerId) {
      console.warn("[MLB_PERSIST_REJECT]", {
        reason: "missing_player_id_for_episode_key",
        player: signal.playerName,
        market: signal.market,
      });
      return { id: "", isDuplicate: true };
    }
    console.log("[MLB_PERSIST_CHECK]", {
      player: signal.playerName,
      market: signal.market,
      recommendedSide: signal.direction,
      probability: signal.probability,
      engineProb: signal.probability,
      signalScore: signal.signalScore ?? null,
      probabilitySemantics: "recommended_side_calibrated",
    });
  }

  // [NBA Hardening v1] NBA-specific persistence guard. Mirrors the MLB guard at
  // the persistence boundary without changing engine math or analytics
  // semantics. Rejects null/NaN/non-finite/<0/>100. signalScore is NEVER
  // substituted. Non-NBA paths are unaffected.
  if (signal.sport === "nba") {
    const p = signal.probability;
    const probValid = typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 100;
    if (!probValid) {
      console.warn("[NBA_PERSIST_REJECT]", {
        reason: "invalid_probability_at_persist",
        player: signal.playerName,
        market: signal.market,
        recommendedSide: signal.direction,
        probability: signal.probability,
        signalScore: signal.signalScore ?? null,
      });
      return { id: "", isDuplicate: true };
    }
    console.log("[NBA_PERSIST_CHECK]", {
      player: signal.playerName,
      market: signal.market,
      recommendedSide: signal.direction,
      probability: signal.probability,
      engineProb: signal.probability,
      signalScore: signal.signalScore ?? null,
    });
  }

  // Phase 6/7 — single source of truth for "is this signal persistable?"
  const validation = validateLiveSignalForDisplay(signal);
  console.log("[PERSIST_CHECK]", JSON.stringify({
    sport: signal.sport,
    gameId: signal.gameId,
    playerName: signal.playerName,
    market: signal.market,
    line: signal.line,
    projection: signal.projection,
    probability: signal.probability,
    sportsbook: signal.sportsbook,
    valid: validation.valid,
    reason: validation.reason ?? null,
  }));
  if (!validation.valid) {
    console.warn(`[PlayTracker] REJECTED — ${validation.reason} for ${signal.playerName} ${signal.market}. Play not persisted.`);
    return { id: "", isDuplicate: true };
  }

  const today = todayET();
  const id = nanoid(16);

  const duplicateGuard = [
    signal.playerId ?? signal.playerName,
    signal.market,
    signal.direction,
    signal.gameId,
    today,
  ].join("|");

  // MLB Live Edge Trust Recovery (Phase 4) — episode-scoped identity, not
  // direction-scoped and not date-scoped. A side flip for the same
  // game+player+market must hit the SAME episode key (storage.recordPlay
  // treats a conflict here as immutable/no-op, never a second official row).
  const officialEpisodeKey =
    signal.sport === "mlb" && signal.playerId
      ? `mlb:v1:${signal.gameId}:${signal.playerId}:${signal.market}`
      : undefined;

  const d = signal.diagnostics;

  const result = await storage.recordPlay({
    id,
    gameId: signal.gameId,
    playerId: signal.playerId ?? undefined,
    playerName: signal.playerName,
    team: signal.team ?? undefined,
    sport: signal.sport,
    market: signal.market,
    direction: signal.direction,
    line: signal.line,
    prob: signal.probability,
    engineProb: signal.probability,
    bookImplied: undefined,
    edgeGap: signal.edge,
    // Canonical no-vig model edge (percentage points) lands in model_edge,
    // tagged with edgeVersion so analytics can filter canonical vs legacy rows.
    // For MLB this overrides the diagnostics-derived modelEdge below.
    edgeVersion: signal.edgeVersion ?? undefined,
    noVigBookProbability: signal.noVigBookProbability ?? undefined,
    probabilitySemantics: signal.probabilitySemantics ?? undefined,
    lane: signal.lane ?? undefined,
    projection: signal.projection,
    sportsbook: signal.sportsbook,
    derivedLine: signal.derivedLine,
    gameDate: today,
    timestamp: new Date(signal.createdAt),
    duplicateGuard,
    officialEpisodeKey,
    oddsSourceUpdatedAt: signal.oddsSourceUpdatedAt ?? undefined,
    oddsFetchedAt: signal.oddsFetchedAt ?? undefined,
    rawProbability: signal.rawProbability ?? undefined,
    officialEligibilityVersion: signal.officialEligibilityVersion ?? undefined,
    officialEligibilityReasons: signal.officialEligibilityReasons?.length
      ? signal.officialEligibilityReasons.join(";")
      : undefined,
    dataQuality: signal.dataQuality ?? undefined,
    currentStatKnown: signal.currentStatKnown ?? undefined,
    calibrationVersion: signal.calibrationVersion ?? undefined,
    archetype: d?.archetype,
    fragilityScore: d?.fragilityScore,
    fragilityPenalty: d?.fragilityPenalty,
    fragilityReasons: d?.fragilityReasons?.join(";"),
    familyId: d?.familyId,
    siblingCount: d?.siblingCount,
    siblingRank: d?.siblingRank,
    flagshipOrDerivative: d?.flagshipOrDerivative,
    familyPenaltyFactor: d?.familyPenaltyFactor,
    calibrationTrack: d?.calibrationTrack,
    confidenceCeilingApplied: d?.confidenceCeilingApplied,
    ceilingReason: d?.ceilingReason,
    rawProbOver: d?.rawProbOver,
    rawProbUnder: d?.rawProbUnder,
    finalProbOver: d?.finalProbOver,
    finalProbUnder: d?.finalProbUnder,
    displayConfidence: d?.displayConfidence,
    modelEdge: signal.modelEdgePctPoints ?? d?.modelEdge,
    minutesExpected: d?.minutesExpected,
    minutesVariance: d?.minutesVariance,
    marketType: d?.marketType,
    playerVolatilityScore: d?.playerVolatilityScore,
    comboCovarianceEstimate: d?.comboCovarianceEstimate,
    engineVersion: d?.engineVersion,
    mu: d?.mu,
    sigma: d?.sigma,
    zScore: d?.zScore,
    odds: signal.odds ?? undefined,
    stake: 1,
    signalScore: signal.signalScore ?? undefined,
    confidenceTier: signal.confidenceTier ?? undefined,
    inning: signal.inning ?? undefined,
    abNumber: signal.abNumber ?? undefined,
    pitchCount: signal.pitchCount ?? undefined,
    contactQualityScore: signal.contactQualityScore ?? undefined,
    opportunityScore: signal.opportunityScore != null ? String(signal.opportunityScore) : undefined,
    liveScore: signal.liveScore != null ? String(signal.liveScore) : undefined,
    eventBoost: signal.eventBoost != null ? String(signal.eventBoost) : undefined,
    // Phase 7.2 — signalMode/marketFamily/engineGeneratedAt are surfaced in
    // PERSIST_CHECK logs above so the engine lineage is auditable. Persisting
    // them as columns is deferred until a clean DB-push window.
  });

  if (!result.isDuplicate) {
    console.log(`[PlayTracker] Tracked play ${id} — ${signal.playerName} ${signal.market} ${signal.direction} ${signal.line} (${signal.sport}) sportsbook=${signal.sportsbook}`);
    // NBA Calibration v2 persistence-parity log. The DB schema does not
    // include dedicated columns for the finalizer telemetry, so we emit a
    // structured fallback log per persisted NBA play so admin can verify
    // engine→persistence parity end-to-end.
    if (signal.sport === "nba" && d?.calibrationVersion) {
      const conflictingSuppressed =
        d.conflictingSignalSuppressed ?? d.conflictingSideSuppressed ?? false;
      console.log("[NBA_CALIBRATION_V2_PERSIST]", JSON.stringify({
        id,
        player: signal.playerName,
        market: signal.market,
        direction: signal.direction,
        line: signal.line,
        probability: signal.probability,
        calibrationVersion: d.calibrationVersion,
        // Canonical calibration-v2 contract field names. Aliases retained
        // for backwards compatibility with existing log consumers.
        rawProbability: d.finalizerInitialPct ?? null,
        finalProbability: d.finalizerFinalPct ?? null,
        probabilityCapApplied: d.finalizerCapReason !== null && d.finalizerCapReason !== undefined,
        capReason: d.finalizerCapReason ?? null,
        conflictingSignalSuppressed: conflictingSuppressed,
        // Legacy/alias field names — kept so older greps keep working.
        finalizerCapReason: d.finalizerCapReason ?? null,
        finalizerMarketRiskTier: d.finalizerMarketRiskTier ?? null,
        finalizerEliteGateApplied: d.finalizerEliteGateApplied ?? false,
        finalizerHighBucketCapped: d.finalizerHighBucketCapped ?? false,
        conflictingSideSuppressed: conflictingSuppressed,
        finalizerInitialPct: d.finalizerInitialPct ?? null,
        finalizerFinalPct: d.finalizerFinalPct ?? null,
        calibrationTrack: d.calibrationTrack ?? null,
      }));
    }
  }

  return result;
}

export async function gradeTrackedPlays(
  storage: IStorage
): Promise<{ settled: number; failed: number; skipped: number }> {
  const result = await gradePersistedPlays(storage);
  if (result.settled > 0) {
    console.log(`[PlayTracker] Auto-graded ${result.settled} plays`);
  }
  return result;
}
