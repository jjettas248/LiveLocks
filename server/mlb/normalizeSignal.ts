import type { MLBSignal } from "../../shared/mlbSignal";

export interface NormalizeContext {
  gameId: string;
  rawOutput: Record<string, any> | null;
  gameState: { inning?: number; isTopInning?: boolean } | null;
  game: { awayAbbr?: string; homeAbbr?: string; status?: string } | null;
  pitchMixFallback: Array<{ pitchType: string; percentage: number; avgVelocity: number | null }> | null;
}

function computeCurrentStatVal(
  market: string,
  cs: { h?: number; hr?: number; tb?: number; rbi?: number; r?: number; sb?: number; k?: number } | null,
): number {
  if (!cs) return 0;
  switch (market) {
    case "hits": return cs.h ?? 0;
    case "home_runs":
    case "hr": return cs.hr ?? 0;
    case "total_bases": return cs.tb ?? 0;
    case "rbi": return cs.rbi ?? 0;
    case "runs": return cs.r ?? 0;
    case "stolen_bases": return cs.sb ?? 0;
    case "batter_strikeouts":
    case "pitcher_strikeouts":
    case "pitcher_k": return cs.k ?? 0;
    case "hrr": return (cs.h ?? 0) + (cs.r ?? 0) + (cs.rbi ?? 0);
    default: return cs.h ?? 0;
  }
}

export function normalizeMLBSignal(
  qs: Record<string, any>,
  ctx: NormalizeContext,
): MLBSignal {
  const raw = ctx.rawOutput;
  const mkt = qs.market as string;
  const normalizedMkt = mkt === "hr" ? "home_runs" : mkt === "pitcher_k" ? "pitcher_strikeouts" : mkt;

  const cs = qs.currentStats as MLBSignal["currentStats"];
  const line = qs.line ?? 0;
  const currentStatVal = qs.currentStat ?? computeCurrentStatVal(normalizedMkt, cs);
  const alreadyHit = qs.alreadyHit ?? (cs != null && line > 0 && currentStatVal >= line);

  const sidedProb = qs.side === "OVER"
    ? (raw?.calibratedProbabilityOver ?? qs.engineProbability ?? 0)
    : (raw?.calibratedProbabilityUnder ?? qs.engineProbability ?? 0);

  const formRaw = qs.formIndicator;
  const formUpper = formRaw ? String(formRaw).toUpperCase() : null;

  let pitchMix = raw?.pitchMix ?? (raw as any)?.pitcher?.pitchMix ?? null;
  if (!pitchMix) pitchMix = ctx.pitchMixFallback;

  return {
    playerId: qs.playerId,
    playerName: qs.playerName,
    gameId: ctx.gameId,
    market: normalizedMkt,
    sportsbook: qs.sportsbook ?? null,

    bookLine: qs.line ?? null,
    projection: qs.projection ?? null,
    enginePct: Math.round(sidedProb * 10) / 10,
    edge: raw ? Math.round(raw.edge * 100) / 100 : null,
    evPct: raw ? Math.round((raw.evPct ?? 0) * 100) / 100 : null,
    recommendedSide: qs.side,
    signalScore: qs.signalScore ?? 0,
    confidenceTier: qs.confidenceTier ?? "WATCHLIST",

    awayAbbr: ctx.game?.awayAbbr ?? null,
    homeAbbr: ctx.game?.homeAbbr ?? null,
    gameStatus: ctx.game?.status ?? null,
    inning: qs.inning ?? ctx.gameState?.inning ?? 0,
    isTopInning: qs.isTopInning ?? ctx.gameState?.isTopInning ?? true,
    homeScore: qs.homeScore ?? 0,
    awayScore: qs.awayScore ?? 0,

    alreadyHit,
    actionable: qs.actionable ?? !alreadyHit,
    stale: qs.stale ?? false,
    watchlist: qs.watchlist ?? false,
    isDegraded: qs.isDegraded ?? false,
    fallbackUsed: qs.fallbackUsed ?? false,

    overOdds: qs.overOdds ?? raw?.overOdds ?? null,
    underOdds: qs.underOdds ?? raw?.underOdds ?? null,
    bookImplied: qs.bookImplied ?? null,
    oddsTimestamp: qs.oddsTimestamp ?? null,

    signalTags: qs.signalTags ?? [],
    feedTags: qs.feedTags ?? [],
    badges: qs.badges ?? [],
    riskFlags: qs.riskFlags ?? [],
    playerGlowEligible: qs.playerGlowEligible ?? false,
    formIndicator: formUpper,

    reasons: qs.reasons ?? [],
    explanationBullets: raw?.explanationBullets ?? qs.reasons ?? [],
    drivers: qs.drivers ?? {},

    currentStats: qs.currentStats ?? null,
    currentStat: currentStatVal,
    completedAB: qs.completedAB ?? 0,
    lastABContact: qs.lastABContact ?? null,
    priorABResults: qs.priorABResults ?? [],

    pitcherName: qs.pitcherName ?? null,
    pitcherHand: qs.pitcherHand ?? null,
    pitcherPitchCount: qs.pitcherPitchCount ?? null,
    pitcherTimesThrough: qs.pitcherTimesThrough ?? null,
    pitchMix,

    batterArchetype: qs.batterArchetype ?? null,
    pitcherArchetype: qs.pitcherArchetype ?? null,
    thesis: qs.thesis ?? null,
    matchupTag: raw?.matchupTag ?? null,
    bvp: qs.bvpHistory ?? null,

    isFlagship: qs.isFlagship ?? false,
    familyPenaltyFactor: qs.familyPenaltyFactor ?? null,
    safetyCeilingApplied: qs.safetyCeilingApplied ?? false,
    dataQuality: qs.dataQuality ?? null,
    signalTimestamp: qs.engineGeneratedAt ?? raw?.engineGeneratedAt ?? Date.now(),
    hrFactors: raw?.hrFactors ?? null,
    rollingForm: qs.rollingForm ?? null,
  };
}
