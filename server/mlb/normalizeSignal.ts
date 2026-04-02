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

const MARKET_LABELS: Record<string, string> = {
  hits: "Hits",
  total_bases: "Total Bases",
  home_runs: "HR",
  pitcher_strikeouts: "Pitcher Ks",
  batter_strikeouts: "Batter Ks",
  pitcher_outs: "Pitcher Outs",
  hits_allowed: "Hits Allowed",
  walks_allowed: "Walks Allowed",
  hr_allowed: "HR Allowed",
};

function generateSmartTags(
  qs: Record<string, any>,
  raw: Record<string, any> | null,
  market: string,
): string[] {
  const tags: string[] = [];
  const drivers = qs.drivers ?? {};
  const badges = qs.badges ?? [];
  const lastAB = qs.lastABContact;
  const form = qs.formIndicator ? String(qs.formIndicator).toUpperCase() : null;
  const isPitcher = market.startsWith("pitcher_") || market === "hits_allowed" || market === "walks_allowed" || market === "hr_allowed";

  if (badges.includes("Explosive Bat Speed") || badges.includes("Elite Bat Speed")) {
    tags.push("⚡ Elite Power");
  } else if (badges.includes("High Bat Speed")) {
    tags.push("⚡ Early Power");
  }

  if (lastAB?.exitVelo != null && lastAB.exitVelo >= 100) {
    tags.push("💥 100+ EV");
  } else if (lastAB?.exitVelo != null && lastAB.exitVelo >= 95) {
    tags.push("💥 Hard Hit");
  }

  if (lastAB?.launchAngle != null && lastAB.launchAngle >= 20 && lastAB.launchAngle <= 35) {
    if (market === "home_runs" || market === "total_bases") {
      tags.push("🚀 Ideal LA");
    }
  }

  if (drivers.handednessMatchup >= 0.65 || drivers.pitchBlendMatchup >= 0.65) {
    tags.push("🎯 Pitch Matchup");
  }

  if (drivers.pitchBlendMatchup >= 0.7) {
    tags.push("🧠 Arsenal Edge");
  }

  if (isPitcher && drivers.pitcherSuppression >= 0.65) {
    tags.push("❄️ High Whiff");
  }

  if (isPitcher && drivers.pitcherDeterioration >= 0.6) {
    tags.push("⚠️ Fatigue");
  }

  if (drivers.parkEnv >= 0.65) {
    tags.push("🏟️ Park Boost");
  }

  if (drivers.hotColdForm >= 0.7 || form === "HOT") {
    tags.push("🔥 Hot Streak");
  }

  if (drivers.bvp >= 0.7) {
    tags.push("📊 BvP Edge");
  }

  if (drivers.contactQuality >= 0.7) {
    tags.push("🎯 Elite Contact");
  }

  if (drivers.lineupOpportunity >= 0.7) {
    tags.push("📈 Lineup Spot");
  }

  if (drivers.bullpenFactor >= 0.65) {
    tags.push("🎯 Bullpen Edge");
  }

  if (qs.inning <= 2 && !qs.alreadyHit) {
    tags.push("⏰ Early Signal");
  }

  const seen = new Set<string>();
  return tags.filter(t => {
    const base = t.split(" ").slice(1).join(" ");
    if (seen.has(base)) return false;
    seen.add(base);
    return true;
  }).slice(0, 3);
}

function generatePrimaryReason(
  qs: Record<string, any>,
  raw: Record<string, any> | null,
  market: string,
): string {
  const side = qs.side === "UNDER" ? "UNDER" : "OVER";

  if (qs.thesis && typeof qs.thesis === "string" && qs.thesis.length > 10) {
    return qs.thesis.length > 80 ? qs.thesis.slice(0, 77) + "…" : qs.thesis;
  }

  const parts: string[] = [];
  const drivers = qs.drivers ?? {};
  const isPitcher = market.startsWith("pitcher_") || market === "hits_allowed" || market === "walks_allowed" || market === "hr_allowed";

  if (drivers.contactQuality >= 0.65 && !isPitcher) parts.push("elite contact");
  else if (drivers.contactQuality >= 0.55 && !isPitcher) parts.push("solid contact");

  if (drivers.batSpeedPower >= 0.65 && !isPitcher) parts.push("power profile");

  if (drivers.handednessMatchup >= 0.65 || drivers.pitchBlendMatchup >= 0.65) {
    parts.push("favorable matchup");
  }

  if (drivers.parkEnv >= 0.6) parts.push("park boost");

  if (drivers.hotColdForm >= 0.65) parts.push("hot form");

  if (isPitcher && drivers.pitcherSuppression >= 0.6) parts.push("dominant stuff");
  if (isPitcher && drivers.pitcherDeterioration >= 0.55) parts.push("pitcher fading");

  if (drivers.bvp >= 0.65) parts.push("BvP history");
  if (drivers.bullpenFactor >= 0.6) parts.push("bullpen advantage");

  if (parts.length === 0) {
    const bullets = raw?.explanationBullets;
    const reasons = qs.reasons;
    const explanations = (Array.isArray(bullets) && bullets.length > 0) ? bullets
      : (Array.isArray(reasons) && reasons.length > 0) ? reasons : [];
    if (explanations.length > 0) {
      const first = String(explanations[0]);
      return first.length > 80 ? first.slice(0, 77) + "…" : first;
    }
    const mktLabel = MARKET_LABELS[market] ?? market;
    return side === "UNDER"
      ? `Model projects ${mktLabel} to stay under the line`
      : `Model projects elevated ${mktLabel} output`;
  }

  const sentence = parts.slice(0, 3).join(" + ");
  const prefix = side === "UNDER" ? "Suppression driven by " : "";
  const result = prefix + sentence;
  return result.charAt(0).toUpperCase() + result.slice(1);
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

  const smartTags = generateSmartTags(qs, raw, normalizedMkt);
  const primaryReason = generatePrimaryReason(qs, raw, normalizedMkt);

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

    smartTags,
    primaryReason,
  };
}
