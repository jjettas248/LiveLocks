import type {
  NBAPlay,
  NBAEngineOutput,
  NBAEngineDiagnostics,
  NBAPlayDiagnostics,
} from "./types";
import { NBA_STRICT_RULES, NBA_FALLBACK_RULES } from "./types";
import { filterNBASignals } from "./validation";

export interface NBAEngineCandidate {
  id?: string;
  playerId?: string;
  playerName?: string;
  player?: string;
  team?: string;
  market?: string;
  statType?: string;
  line?: number | null;
  projection?: number | null;
  probability?: number | null;
  edge?: number | null;
  recommendedSide?: string;
  betDirection?: string;
  sportsbook?: string;
  derivedLine?: boolean;
  gameId?: string;
  createdAt?: number;
  engineGeneratedAt?: number;
  lineSource?: string;
  availableBooks?: string[];
  bestOdds?: any;
  engineDiagnostics?: any;
  [key: string]: any;
}

function mapCandidateToPlay(c: NBAEngineCandidate, idx: number): NBAPlay | null {
  const prob = c.probability;
  if (prob == null || !Number.isFinite(prob)) return null;

  const edge = c.edge;
  if (edge == null || !Number.isFinite(edge)) return null;

  const line = c.line;
  if (line == null || !Number.isFinite(line)) return null;

  const projection = c.projection ?? line;
  const side = (c.recommendedSide ?? c.betDirection ?? "OVER").toUpperCase() as "OVER" | "UNDER";

  let confidence: "low" | "medium" | "high";
  if (prob >= 75) confidence = "high";
  else if (prob >= 65) confidence = "medium";
  else confidence = "low";

  const diag: NBAPlayDiagnostics | undefined = c.engineDiagnostics ? {
    archetype: c.engineDiagnostics.archetype,
    fragilityScore: c.engineDiagnostics.fragilityScore,
    fragilityPenalty: c.engineDiagnostics.fragilityPenalty,
    fragilityReasons: c.engineDiagnostics.fragilityReasons,
    rawProbOver: c.engineDiagnostics.rawProbOver,
    rawProbUnder: c.engineDiagnostics.rawProbUnder,
    finalProbOver: c.engineDiagnostics.finalProbOver,
    finalProbUnder: c.engineDiagnostics.finalProbUnder,
    displayConfidence: c.engineDiagnostics.displayConfidence,
    modelEdge: c.engineDiagnostics.modelEdge,
    minutesExpected: c.engineDiagnostics.minutesExpected,
    minutesVariance: c.engineDiagnostics.minutesVariance,
    marketType: c.engineDiagnostics.marketType,
    playerVolatilityScore: c.engineDiagnostics.playerVolatilityScore,
    calibrationTrack: c.engineDiagnostics.calibrationTrack,
    confidenceCeilingApplied: c.engineDiagnostics.confidenceCeilingApplied,
    ceilingReason: c.engineDiagnostics.ceilingReason,
    engineVersion: c.engineDiagnostics.engineVersion,
  } : undefined;

  return {
    id: c.id ?? `nba-${c.playerId ?? idx}-${c.market ?? c.statType ?? "prop"}-${Date.now()}`,
    playerId: c.playerId ?? String(idx),
    playerName: c.playerName ?? c.player ?? "Unknown",
    team: c.team ?? "",
    market: c.market ?? c.statType ?? "unknown",
    line,
    projection,
    probability: prob,
    edge,
    recommendedSide: side,
    confidence,
    sportsbook: c.sportsbook ?? "consensus",
    derivedLine: c.derivedLine ?? false,
    gameId: c.gameId ?? "",
    createdAt: c.createdAt ?? c.engineGeneratedAt ?? Date.now(),
    lineSource: (c.lineSource as any) ?? (c.derivedLine ? "derived" : "sportsbook"),
    availableBooks: c.availableBooks,
    bestOdds: c.bestOdds,
    diagnostics: diag,
  };
}

export function processNBAEngine(candidates: NBAEngineCandidate[]): NBAEngineOutput {
  const allPlays: NBAPlay[] = [];
  const reasonsFilteredOut: string[] = [];
  let totalEvaluated = candidates.length;

  for (let i = 0; i < candidates.length; i++) {
    const play = mapCandidateToPlay(candidates[i], i);
    if (play) allPlays.push(play);
    else reasonsFilteredOut.push(`Candidate ${i}: invalid data (missing line/prob/edge)`);
  }

  const strictAcc = { filtered: 0, reasons: [] as string[] };
  const strictPlays = filterNBASignals(allPlays, NBA_STRICT_RULES, strictAcc);

  let finalPlays: NBAPlay[];
  let mode: "strict" | "fallback";
  let fallbackTriggered = false;

  if (strictPlays.length > 0) {
    finalPlays = strictPlays;
    mode = "strict";
  } else {
    fallbackTriggered = true;
    const fallbackAcc = { filtered: 0, reasons: [] as string[] };
    const fallbackPlays = filterNBASignals(allPlays, NBA_FALLBACK_RULES, fallbackAcc);

    if (fallbackPlays.length > 0) {
      finalPlays = fallbackPlays;
    } else if (allPlays.length > 0) {
      finalPlays = allPlays
        .filter(p => p.probability >= 50 && Number.isFinite(p.edge))
        .sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge))
        .slice(0, 3);
    } else {
      finalPlays = [];
    }
    mode = "fallback";
    reasonsFilteredOut.push(...strictAcc.reasons);
  }

  const confBreakdown = { high: 0, medium: 0, low: 0 };
  let overallConfidence: "low" | "medium" | "high" = "low";
  for (const p of finalPlays) {
    confBreakdown[p.confidence]++;
  }
  if (confBreakdown.high > 0) overallConfidence = "high";
  else if (confBreakdown.medium > 0) overallConfidence = "medium";

  const diagnostics: NBAEngineDiagnostics = {
    totalEvaluated,
    totalPassed: finalPlays.length,
    totalFiltered: totalEvaluated - finalPlays.length,
    reasonsFilteredOut,
    fallbackTriggered,
    confidenceBreakdown: confBreakdown,
    regressionApplied: true,
    edgeThresholdUsed: mode === "strict" ? NBA_STRICT_RULES.minEdge : NBA_FALLBACK_RULES.minEdge,
    dataFreshness: Date.now(),
  };

  return {
    plays: finalPlays,
    engine: "NBA",
    mode,
    confidence: overallConfidence,
    diagnostics,
    timestamp: Date.now(),
  };
}

export type { NBAPlay, NBAEngineOutput, NBAEngineDiagnostics };
