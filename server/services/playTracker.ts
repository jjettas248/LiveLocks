import type { IStorage } from "../storage";
import { gradePersistedPlays } from "./gradePersistedPlays";
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
  edge: number;
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
}

export async function trackPlay(
  signal: TrackableSignal,
  storage: IStorage
): Promise<{ id: string; isDuplicate: boolean }> {
  if (!signal.sportsbook || signal.sportsbook.trim() === "") {
    console.warn(`[PlayTracker] REJECTED — missing sportsbook for ${signal.playerName} ${signal.market}. Play not persisted.`);
    return { id: "", isDuplicate: true };
  }
  if (!Number.isFinite(signal.line)) {
    console.warn(`[PlayTracker] REJECTED — non-finite line (${signal.line}) for ${signal.playerName} ${signal.market}. Play not persisted.`);
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
    projection: signal.projection,
    sportsbook: signal.sportsbook,
    derivedLine: signal.derivedLine,
    gameDate: today,
    timestamp: new Date(signal.createdAt),
    duplicateGuard,
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
    modelEdge: d?.modelEdge,
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
  });

  if (!result.isDuplicate) {
    console.log(`[PlayTracker] Tracked play ${id} — ${signal.playerName} ${signal.market} ${signal.direction} ${signal.line} (${signal.sport}) sportsbook=${signal.sportsbook}`);
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
