import type {
  MLBPlay,
  MLBEngineOutput,
  MLBEngineDiagnostics,
  MLBContactProfile,
  MLBPlayDiagnostics,
} from "./types";
import { MLB_STRICT_RULES, MLB_FALLBACK_RULES } from "./types";
import { filterMLBSignals } from "./validation";

export interface MLBEngineCandidate {
  id?: string;
  playerId?: string;
  playerName?: string;
  team?: string | null;
  market?: string;
  line?: number;
  projection?: number;
  probability?: number;
  engineProbability?: number;
  edge?: number;
  recommendedSide?: string;
  side?: string;
  sportsbook?: string;
  derivedLine?: boolean;
  gameId?: string;
  createdAt?: number;
  signalScore?: number;
  confidenceTier?: string;
  currentStats?: Record<string, number> | null;
  lastABContact?: any;
  batterArchetype?: string;
  pitcherArchetype?: string;
  thesis?: string;
  isFlagship?: boolean;
  safetyCeilingApplied?: boolean;
  dataQuality?: string;
  [key: string]: any;
}

function mapMLBConfidence(tier: string | undefined, prob: number): "developing" | "strong" | "elite" {
  const t = (tier ?? "").toUpperCase();
  if (t === "ELITE") return "elite";
  if (t === "STRONG" || t === "SOLID") return "strong";
  if (t === "WATCHLIST" || t === "NO_SIGNAL" || t === "DEVELOPING") return "developing";
  if (prob >= 70) return "elite";
  if (prob >= 58) return "strong";
  return "developing";
}

function buildContactProfile(candidates: MLBEngineCandidate[]): MLBContactProfile | null {
  const contacts = candidates
    .map(c => c.lastABContact)
    .filter(Boolean);

  if (contacts.length === 0) return null;

  const evs = contacts.map(c => c.exitVelo).filter((v: any) => v != null && Number.isFinite(v));
  const las = contacts.map(c => c.launchAngle).filter((v: any) => v != null && Number.isFinite(v));
  const barrels = contacts.map(c => c.barrelPct).filter((v: any) => v != null);
  const hardHits = contacts.map(c => c.hardHitPct).filter((v: any) => v != null);

  const avgEV = evs.length > 0 ? evs.reduce((a: number, b: number) => a + b, 0) / evs.length : null;
  const maxEV = evs.length > 0 ? Math.max(...evs) : null;
  const avgLA = las.length > 0 ? las.reduce((a: number, b: number) => a + b, 0) / las.length : null;
  const avgBarrel = barrels.length > 0 ? barrels.reduce((a: number, b: number) => a + b, 0) / barrels.length : null;
  const avgHH = hardHits.length > 0 ? hardHits.reduce((a: number, b: number) => a + b, 0) / hardHits.length : null;

  const xBAs = contacts.map(c => c.perABxBA).filter((v: any) => v != null && Number.isFinite(v));
  const gameAvgXBA = xBAs.length > 0 ? Math.round((xBAs.reduce((a: number, b: number) => a + b, 0) / xBAs.length) * 1000) / 1000 : null;
  const gameMaxXBA = xBAs.length > 0 ? Math.max(...xBAs) : null;

  let quality: "elite" | "strong" | "developing" | "weak" = "developing";
  if (gameAvgXBA != null && gameAvgXBA >= 0.500) quality = "elite";
  else if (avgEV != null && avgEV >= 95) quality = "elite";
  else if (gameAvgXBA != null && gameAvgXBA >= 0.350) quality = "strong";
  else if (avgEV != null && avgEV >= 88) quality = "strong";
  else if (avgEV != null && avgEV < 80 && (gameAvgXBA == null || gameAvgXBA < 0.200)) quality = "weak";

  const barrelCount = contacts.filter(c => c.contactGrade === "barrel").length;

  return {
    avgExitVelo: avgEV != null ? Math.round(avgEV * 10) / 10 : null,
    maxExitVelo: maxEV != null ? Math.round(maxEV * 10) / 10 : null,
    avgLaunchAngle: avgLA != null ? Math.round(avgLA * 10) / 10 : null,
    barrelRate: avgBarrel != null ? Math.round(avgBarrel * 10) / 10 : null,
    hardHitRate: avgHH != null ? Math.round(avgHH * 10) / 10 : null,
    contactQuality: quality,
    gameAvgXBA,
    gameMaxXBA,
    gameBarrelCount: barrelCount,
  };
}

function mapCandidateToPlay(c: MLBEngineCandidate, idx: number): MLBPlay | null {
  const prob = c.probability ?? c.engineProbability;
  if (prob == null || !Number.isFinite(prob)) {
    // [MLB_PRE_CHANGE_AUDIT] STEP 2 — Filtering trace at engine entry.
    console.log(`[MLB_FILTERED_OUT] ${JSON.stringify({
      stage: "mapCandidateToPlay",
      reason: "invalid_prob",
      player: c.playerName ?? `idx_${idx}`,
      market: c.market ?? null,
      probability: prob ?? null,
      line: c.line ?? null,
      edge: c.edge ?? null,
    })}`);
    return null;
  }

  const line = c.line;
  if (line == null || !Number.isFinite(line)) {
    console.log(`[MLB_FILTERED_OUT] ${JSON.stringify({
      stage: "mapCandidateToPlay",
      reason: "invalid_line",
      player: c.playerName ?? `idx_${idx}`,
      market: c.market ?? null,
      probability: prob,
      line: line ?? null,
      edge: c.edge ?? null,
    })}`);
    return null;
  }

  const edge = c.edge ?? 0;
  const side = (c.recommendedSide ?? c.side ?? "OVER").toUpperCase() as "OVER" | "UNDER";
  const confidence = mapMLBConfidence(c.confidenceTier, prob);

  const diag: MLBPlayDiagnostics | undefined = {
    archetype: c.batterArchetype,
    pitcherArchetype: c.pitcherArchetype,
    thesis: c.thesis,
    isFlagship: c.isFlagship,
    safetyCeilingApplied: c.safetyCeilingApplied,
    dataQuality: c.dataQuality,
    engineVersion: "mlb-isolated-v1",
  };

  return {
    id: c.id ?? `mlb-${c.playerId ?? idx}-${c.market ?? "prop"}-${Date.now()}`,
    playerId: c.playerId ?? String(idx),
    playerName: c.playerName ?? "Unknown",
    team: c.team ?? null,
    market: c.market ?? "unknown",
    line,
    projection: c.projection ?? line,
    probability: prob,
    edge,
    recommendedSide: side,
    confidence,
    sportsbook: c.sportsbook ?? "consensus",
    derivedLine: c.derivedLine ?? false,
    gameId: c.gameId ?? "",
    createdAt: c.createdAt ?? Date.now(),
    signalScore: c.signalScore,
    confidenceTier: c.confidenceTier,
    currentStats: c.currentStats,
    lastABContact: c.lastABContact,
    contactProfile: c.lastABContact ? (buildContactProfile([c]) ?? undefined) : undefined,
    diagnostics: diag,
  };
}

export function processMLBEngine(candidates: MLBEngineCandidate[]): MLBEngineOutput {
  const allPlays: MLBPlay[] = [];
  const reasonsFilteredOut: string[] = [];
  const totalEvaluated = candidates.length;

  for (let i = 0; i < candidates.length; i++) {
    const play = mapCandidateToPlay(candidates[i], i);
    if (play) allPlays.push(play);
    else reasonsFilteredOut.push(`Candidate ${i}: invalid data (missing line/prob)`);
  }

  // [MLB_PRE_CHANGE_AUDIT] STEP 1 — Engine candidate output trace.
  // Emits the raw count of mapped candidates and a 3-row sample so we can
  // see whether the engine is producing candidates at all (vs. being filtered
  // downstream) and whether feature data (BvP / weather / handedness) is
  // present on the candidate at engine entry.
  console.log(`[MLB_ENGINE_OUTPUT] ${JSON.stringify({
    totalCandidates: allPlays.length,
    totalEvaluated,
    invalidDropped: totalEvaluated - allPlays.length,
    sample: allPlays.slice(0, 3).map(p => ({
      player: p.playerName,
      market: p.market,
      projection: p.projection,
      probability: Math.round(p.probability * 100) / 100,
      edge: Math.round(p.edge * 100) / 100,
      line: p.line,
      side: p.recommendedSide,
      hasBvp: !!(p as any).bvp,
      hasWeather: !!(p as any).weather,
      hasHandedness: !!(p as any).handedness,
      batterArchetype: p.diagnostics?.archetype ?? null,
      pitcherArchetype: p.diagnostics?.pitcherArchetype ?? null,
    })),
  })}`);

  const fallbackAcc = { filtered: 0, reasons: [] as string[] };
  const fallbackPlays = filterMLBSignals(allPlays, MLB_FALLBACK_RULES, fallbackAcc);

  const strictAcc = { filtered: 0, reasons: [] as string[] };
  const strictPlays = filterMLBSignals(allPlays, MLB_STRICT_RULES, strictAcc);
  const strictIds = new Set(strictPlays.map(p => p.id));

  let finalPlays: MLBPlay[];
  let mode: "strict" | "fallback";
  let fallbackTriggered = false;

  if (fallbackPlays.length > 0) {
    finalPlays = fallbackPlays.sort((a, b) => {
      const aStrict = strictIds.has(a.id) ? 1 : 0;
      const bStrict = strictIds.has(b.id) ? 1 : 0;
      if (bStrict !== aStrict) return bStrict - aStrict;
      return b.probability - a.probability;
    });
    mode = strictPlays.length > 0 ? "strict" : "fallback";
    fallbackTriggered = strictPlays.length === 0;
  } else if (allPlays.length > 0) {
    finalPlays = allPlays.sort((a, b) => b.probability - a.probability).slice(0, 5);
    mode = "fallback";
    fallbackTriggered = true;
  } else {
    finalPlays = [];
    mode = "fallback";
    fallbackTriggered = true;
  }
  reasonsFilteredOut.push(...fallbackAcc.reasons);

  const confBreakdown = { elite: 0, strong: 0, developing: 0 };
  for (const p of finalPlays) {
    confBreakdown[p.confidence]++;
  }
  let overallConfidence: "developing" | "strong" | "elite" = "developing";
  if (confBreakdown.elite > 0) overallConfidence = "elite";
  else if (confBreakdown.strong > 0) overallConfidence = "strong";

  const contactProfile = buildContactProfile(candidates);

  const diagnostics: MLBEngineDiagnostics = {
    totalEvaluated,
    totalPassed: finalPlays.length,
    totalFiltered: totalEvaluated - finalPlays.length,
    reasonsFilteredOut,
    fallbackTriggered,
    confidenceBreakdown: confBreakdown,
    contactThresholdUsed: mode === "strict" ? "strong" : "developing",
    dataFreshness: Date.now(),
  };

  // [MLB_PRE_CHANGE_AUDIT] STEP 3 — Surfaced signals trace.
  // Emits the final list returned to consumers (orchestrator + routes).
  console.log(`[MLB_SURFACED_SIGNALS] ${JSON.stringify({
    count: finalPlays.length,
    mode,
    fallbackTriggered,
    confidence: overallConfidence,
    players: finalPlays.map(p => p.playerName),
    markets: finalPlays.map(p => p.market),
  })}`);

  // [MLB_PRE_CHANGE_AUDIT] STEP 4 — Empty-state warning at engine layer.
  if (finalPlays.length === 0) {
    console.warn(`[MLB_EMPTY_STATE] ${JSON.stringify({
      layer: "engine",
      candidateCount: allPlays.length,
      totalEvaluated,
      totalFiltered: diagnostics.totalFiltered,
      fallbackTriggered,
      reasons: reasonsFilteredOut.slice(0, 10),
      message: "NO_SIGNALS_AFTER_FILTERING",
    })}`);
  }

  return {
    plays: finalPlays,
    engine: "MLB",
    mode,
    confidence: overallConfidence,
    contactProfile,
    diagnostics,
    timestamp: Date.now(),
  };
}

export type { MLBPlay, MLBEngineOutput, MLBEngineDiagnostics, MLBContactProfile };
