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
  const pitchCount = qs.pitcherPitchCount ?? 0;
  const timesThrough = qs.pitcherTimesThrough ?? 0;
  const line = qs.line ?? 0;
  const currentStatVal = qs.currentStat ?? computeCurrentStatVal(market, qs.currentStats ?? null);

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

  if (drivers.handednessMatchup >= 0.55 || drivers.pitchBlendMatchup >= 0.55) {
    tags.push("🎯 Matchup Edge");
  }

  if (drivers.pitchBlendMatchup >= 0.60) {
    tags.push("🧠 Arsenal Edge");
  }

  if (isPitcher && drivers.pitcherSuppression >= 0.55) {
    tags.push("❄️ High Whiff");
  }

  if (!isPitcher && pitchCount >= 75) {
    tags.push("⚠️ Pitcher Tiring");
  } else if (!isPitcher && timesThrough >= 3) {
    tags.push("🔄 3rd Time Through");
  }

  if (isPitcher && drivers.pitcherDeterioration >= 0.50) {
    tags.push("⚠️ Fatigue");
  }

  if (drivers.parkEnv >= 0.55) {
    tags.push("🏟️ Park Boost");
  } else if (drivers.parkEnv <= 0.30) {
    tags.push("🏟️ Tough Park");
  }

  if (drivers.hotColdForm >= 0.55 || form === "HOT") {
    tags.push("🔥 Hot Streak");
  } else if (form === "WARM") {
    tags.push("🔥 Warming Up");
  }

  if (drivers.bvp >= 0.55) {
    tags.push("📊 BvP Edge");
  }

  if (drivers.contactQuality >= 0.65) {
    tags.push("🎯 Elite Contact");
  } else if (drivers.contactQuality >= 0.55) {
    tags.push("🎯 Solid Contact");
  }

  if (drivers.lineupOpportunity >= 0.55) {
    tags.push("📈 Lineup Spot");
  }

  if (drivers.bullpenFactor >= 0.55) {
    tags.push("🎯 Bullpen Edge");
  }

  if (line > 0 && currentStatVal >= line - 1 && currentStatVal < line && !qs.alreadyHit) {
    tags.push("📍 1 Away");
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

  const thesis = qs.thesis && typeof qs.thesis === "string" && qs.thesis.length > 10 ? qs.thesis : null;
  const isGenericThesis = thesis != null && (
    thesis.startsWith("Limited sample") ||
    thesis.startsWith("Model projection based")
  );

  if (thesis && !isGenericThesis) {
    return thesis.length > 80 ? thesis.slice(0, 77) + "…" : thesis;
  }

  const parts: string[] = [];
  const drivers = qs.drivers ?? {};
  const isPitcher = market.startsWith("pitcher_") || market === "hits_allowed" || market === "walks_allowed" || market === "hr_allowed";

  if (drivers.contactQuality >= 0.55 && !isPitcher) parts.push("solid contact");
  if (drivers.batSpeedPower >= 0.55 && !isPitcher) parts.push("power profile");

  if (drivers.handednessMatchup >= 0.55 || drivers.pitchBlendMatchup >= 0.55) {
    parts.push("favorable matchup");
  }

  if (drivers.parkEnv >= 0.55) parts.push("park boost");
  if (drivers.hotColdForm >= 0.55) parts.push("hot form");

  if (isPitcher && drivers.pitcherSuppression >= 0.50) parts.push("dominant stuff");
  if (isPitcher && drivers.pitcherDeterioration >= 0.45) parts.push("pitcher fading");

  if (drivers.bvp >= 0.55) parts.push("BvP history");
  if (drivers.bullpenFactor >= 0.50) parts.push("bullpen advantage");

  if (!isPitcher) {
    const pitchCount = qs.pitcherPitchCount ?? 0;
    const timesThrough = qs.pitcherTimesThrough ?? 0;
    if (pitchCount >= 75) parts.push("pitcher fatigued");
    else if (timesThrough >= 3) parts.push("3rd time through order");
  }

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

  const drivers = qs.drivers ?? {};
  let pitchMatchupRatings: Record<string, "strong" | "neutral" | "weak"> | null = null;
  if (pitchMix && Array.isArray(pitchMix) && pitchMix.length > 0) {
    const cq = drivers.contactQuality ?? 0.5;
    const bp = drivers.batSpeedPower ?? 0.5;
    const pbm = drivers.pitchBlendMatchup ?? 0.5;
    pitchMatchupRatings = {};
    for (const p of pitchMix) {
      const pt = p.pitchType;
      const isFastball = pt === "FF" || pt === "SI" || pt === "FC";
      const isBreaking = pt === "SL" || pt === "CU" || pt === "KC" || pt === "CS" || pt === "SV" || pt === "ST";
      let rating: "strong" | "neutral" | "weak" = "neutral";
      if (isFastball) {
        if (bp >= 0.55 && cq >= 0.50) rating = "strong";
        else if (bp < 0.40 || cq < 0.40) rating = "weak";
      } else if (isBreaking) {
        if (cq >= 0.55 && pbm >= 0.50) rating = "strong";
        else if (cq < 0.40 || pbm < 0.40) rating = "weak";
      } else {
        if (cq >= 0.55) rating = "strong";
        else if (cq < 0.40) rating = "weak";
      }
      pitchMatchupRatings[pt] = rating;
    }
  }

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
    pitchMatchupRatings,
  };
}
