import type { MLBSignal, PitchMatchupRating } from "../../shared/mlbSignal";
import { normalizePitchTypeCode, getPitchFamily, PITCH_DISPLAY_LABEL } from "./pitchTypeNormalizer";
import type { CanonicalPitchType } from "./pitchTypeNormalizer";
import { deriveSignalTier, type SignalTier } from "./signalScore";

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

  if (qs.isEarlySignal) {
    tags.push("🔎 Pre-Game Edge");
  } else if (qs.inning <= 2 && !qs.alreadyHit) {
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
  const prefix = side === "UNDER" ? "Under driven by " : "";
  const result = prefix + sentence;
  return result.charAt(0).toUpperCase() + result.slice(1);
}

/**
 * Per-pitch bidirectional arsenal scorer.
 * Returns a record keyed by canonical pitch type with explicit `favor` for the client.
 *
 * Score interpretation (always batter-relative):
 *   - score > 0.5  → favors the batter (▲)
 *   - score < 0.5  → favors the pitcher (▼)
 *   - 0.45..0.55  → neutral
 *
 * Family-distinct weights prevent the arsenal from clustering uniformly:
 *   - Fastball (FF):  bat speed + contact + handedness
 *   - Sinker (SI):    contact + handedness, slight HR penalty
 *   - Cutter (FC):    bat speed + pitch blend, slight pitcher edge baseline
 *   - Slider (SL):    pitch blend + handedness
 *   - Sweeper (SW):   harsher than slider for batters
 *   - Curve (CU):     pitch blend + form
 *   - Knuckle Curve:  harsher than curve
 *   - Changeup (CH):  pitch blend + handedness + contact stability
 *   - Splitter (FS):  harshest offspeed
 *   - Other (OT):     neutral fallback
 */
export function computePitchArsenalMatchupRatings(
  pitchMix: Array<{ pitchType: string; percentage: number; pitchName?: string | null; avgVelocity?: number | null }>,
  drivers: Record<string, any>,
  market: string,
): Record<string, PitchMatchupRating> {
  const cq = clamp01(drivers.contactQuality ?? 0.5);
  const bp = clamp01(drivers.batSpeedPower ?? 0.5);
  const pbm = clamp01(drivers.pitchBlendMatchup ?? 0.5);
  const hand = clamp01(drivers.handednessMatchup ?? 0.5);
  const form = clamp01(drivers.hotColdForm ?? 0.5);
  const pitcherSupp = clamp01(drivers.pitcherSuppression ?? 0.5);

  const isPitcherMarket = market.startsWith("pitcher_") ||
    market === "hits_allowed" || market === "walks_allowed" || market === "hr_allowed";

  // Convert each driver into a centered modifier: > 0 = batter favor, < 0 = pitcher favor
  const cqM = (cq - 0.5);
  const bpM = (bp - 0.5);
  const pbmM = (pbm - 0.5);
  const handM = (hand - 0.5);
  const formM = (form - 0.5);
  // pitcherSuppression is pitcher-relative — inverted for batter score
  const suppM = (0.5 - pitcherSupp);

  const out: Record<string, PitchMatchupRating> = {};

  for (const p of pitchMix) {
    // Always canonicalize — uppercase non-canonical codes (ST/SV/CS/KN) must
    // route through the normalizer so they map to FF/SI/SL/SW/etc.
    const code = normalizePitchTypeCode(p.pitchType);

    let score = 0.5;

    switch (code) {
      case "FF":
        // Four-seam: bat speed dominates, contact second, platoon/form modifier
        score = 0.50 + bpM * 0.50 + cqM * 0.30 + handM * 0.18 + formM * 0.10 + suppM * 0.10;
        break;
      case "SI":
        // Sinker: groundball pitch — power gets less, contact + platoon matter most
        // Slight pitcher baseline for HR/TB markets
        score = 0.50 + cqM * 0.40 + handM * 0.25 + bpM * 0.12 + formM * 0.08 + suppM * 0.10;
        if (market === "home_runs" || market === "hr_allowed") score -= 0.04;
        break;
      case "FC":
        // Cutter: tougher than 4-seam, blend matters
        score = 0.50 + bpM * 0.30 + pbmM * 0.30 + cqM * 0.20 + handM * 0.15 + suppM * 0.10 - 0.03;
        break;
      case "SL":
        // Slider: pitch blend + handedness drive it
        score = 0.50 + pbmM * 0.45 + handM * 0.25 + cqM * 0.18 + formM * 0.10 + suppM * 0.10;
        break;
      case "SW":
        // Sweeper: harsher than slider — biggest platoon swing
        score = 0.50 + pbmM * 0.40 + handM * 0.35 + cqM * 0.15 + suppM * 0.12 - 0.04;
        break;
      case "CU":
        // Curveball: blend + form (timing-dependent)
        score = 0.50 + pbmM * 0.42 + formM * 0.20 + cqM * 0.20 + handM * 0.15 + suppM * 0.10;
        break;
      case "KC":
        // Knuckle curve: harsher curve variant
        score = 0.50 + pbmM * 0.40 + cqM * 0.18 + handM * 0.15 + suppM * 0.12 - 0.05;
        break;
      case "CH":
        // Changeup: blend + handedness, contact stability matters most
        score = 0.50 + pbmM * 0.38 + handM * 0.30 + cqM * 0.25 + formM * 0.10 + suppM * 0.10;
        break;
      case "FS":
        // Splitter: harshest offspeed — punishes power, rewards platoon
        score = 0.50 + pbmM * 0.40 + handM * 0.28 + cqM * 0.18 - bpM * 0.12 + suppM * 0.10 - 0.05;
        break;
      case "OT":
      default:
        // Unknown — neutral fallback weighted by aggregate quality
        score = 0.50 + cqM * 0.30 + pbmM * 0.25 + bpM * 0.20 + handM * 0.15 + suppM * 0.10;
        break;
    }

    // Pitcher-side markets reverse-interpret the legacy "rating" string but the
    // explicit `favor` field always remains batter-relative.
    score = clamp01(score);

    let favor: PitchMatchupRating["favor"] = "neutral";
    if (score >= 0.55) favor = "batter";
    else if (score <= 0.45) favor = "pitcher";

    let rating: PitchMatchupRating["rating"];
    if (isPitcherMarket) {
      rating = score >= 0.55 ? "weak" : score <= 0.45 ? "strong" : "neutral";
    } else {
      rating = score >= 0.55 ? "strong" : score <= 0.45 ? "weak" : "neutral";
    }

    out[code] = { rating, favor, score: Math.round(score * 1000) / 1000 };
  }

  return out;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

// ── MLB Canonical Display Contract ───────────────────────────────────────
// Server-owned grade. NEVER derived from liveScore or raw probability — the
// only inputs are the canonical signalTier (Phase 2) and signalScore.
function deriveDisplayGrade(
  signalTier: SignalTier,
  signalScore: number,
): "A+" | "A" | "B+" | "B" | "B-" | "Watch" {
  if (signalTier === "elite" && signalScore >= 80) return "A+";
  if (signalTier === "strong" && signalScore >= 70) return "A";
  if (signalTier === "strong" && signalScore >= 60) return "B+";
  if (signalTier === "lean" && signalScore >= 55) return "B";
  if (signalTier === "lean" && signalScore >= 45) return "B-";
  return "Watch";
}

function buildDisplayDrivers(qs: Record<string, any>, market: string): string[] {
  const drivers = qs.drivers ?? {};
  const isPitcher = market.startsWith("pitcher_") || market === "hits_allowed" || market === "walks_allowed" || market === "hr_allowed";
  const out: string[] = [];
  if (!isPitcher) {
    if (drivers.contactQuality >= 0.65) out.push("Elite Contact");
    else if (drivers.contactQuality >= 0.55) out.push("Solid Contact");
    if (drivers.batSpeedPower >= 0.60) out.push("Power Profile");
    if (drivers.handednessMatchup >= 0.55 || drivers.pitchBlendMatchup >= 0.55) out.push("Matchup Edge");
    if (drivers.parkEnv >= 0.55) out.push("Park Boost");
    if (drivers.hotColdForm >= 0.55) out.push("Hot Form");
  } else {
    if (drivers.pitcherSuppression >= 0.55) out.push("Dominant Stuff");
    if (drivers.pitcherDeterioration >= 0.50) out.push("Fatigue Risk");
    if (drivers.bullpenFactor >= 0.55) out.push("Bullpen Edge");
  }
  return out.slice(0, 3);
}

function buildBaseMLBSignal(
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

  // Cache paired probabilities so the canonical resolver can render Over/Under
  // for the same player+market+line everywhere (box score badge + calculator).
  const calibProbOver: number | null = raw?.calibratedProbabilityOver != null
    ? Math.round((raw.calibratedProbabilityOver as number) * 10) / 10
    : (qs.side === "OVER" && qs.engineProbability != null
        ? Math.round((qs.engineProbability as number) * 10) / 10
        : null);
  const calibProbUnder: number | null = raw?.calibratedProbabilityUnder != null
    ? Math.round((raw.calibratedProbabilityUnder as number) * 10) / 10
    : (qs.side === "UNDER" && qs.engineProbability != null
        ? Math.round((qs.engineProbability as number) * 10) / 10
        : null);

  const formRaw = qs.formIndicator;
  const formUpper = formRaw ? String(formRaw).toUpperCase() : null;

  let pitchMix = raw?.pitchMix ?? (raw as any)?.pitcher?.pitchMix ?? null;
  if (!pitchMix) pitchMix = ctx.pitchMixFallback;

  const smartTags = generateSmartTags(qs, raw, normalizedMkt);
  const primaryReason = generatePrimaryReason(qs, raw, normalizedMkt);

  const drivers = qs.drivers ?? {};
  let pitchMatchupRatings: Record<string, PitchMatchupRating> | null = null;
  if (pitchMix && Array.isArray(pitchMix) && pitchMix.length > 0) {
    pitchMatchupRatings = computePitchArsenalMatchupRatings(pitchMix, drivers, normalizedMkt);
    try {
      const families = Object.entries(pitchMatchupRatings).map(([k, v]) => `${k}:${v.favor[0]}${v.score.toFixed(2)}`).join(",");
      console.log(`[MLB_PITCH_ARSENAL] player=${qs.playerName} market=${normalizedMkt} pitches=${families}`);
    } catch {}
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
    calibratedProbabilityOver: calibProbOver,
    calibratedProbabilityUnder: calibProbUnder,
    edge: raw ? Math.round(raw.edge * 100) / 100 : null,
    evPct: raw ? Math.round((raw.evPct ?? 0) * 100) / 100 : null,
    recommendedSide: qs.side,
    signalScore: qs.signalScore ?? 0,
    confidenceTier: qs.confidenceTier ?? "WATCHLIST",
    // [MLB Canonical Signal Tier — Phase 2] Pass the orchestrator-stamped
    // canonical tier through verbatim. If the orchestrator hasn't stamped it
    // yet (cache rollover, legacy signal), derive it from confidenceTier here
    // and emit a fallback log so we can detect and fix the missing stamp.
    signalTier: ((): SignalTier => {
      const stamped = qs.signalTier as SignalTier | undefined;
      if (stamped === "elite" || stamped === "strong" || stamped === "lean" || stamped === "watch") {
        return stamped;
      }
      const derived = deriveSignalTier(qs.confidenceTier);
      try {
        console.log("[MLB_TIER_FALLBACK]", {
          surface: "normalizeSignal",
          player: qs.playerName,
          market: normalizedMkt,
          confidenceTier: qs.confidenceTier,
          derivedSignalTier: derived,
        });
      } catch {}
      return derived;
    })(),

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
    isEarlySignal: qs.isEarlySignal ?? false,
    isDegraded: qs.isDegraded ?? false,
    fallbackUsed: qs.fallbackUsed ?? false,

    // MLB Signals audit P2/P3 — surface engine-owned state machine + decay
    // rail to the client. Engine-as-truth: present only when the engine
    // computed them (non-HR markets); HR markets continue to use `hrAlert`.
    engineState: qs.engineState,
    engineStateChangedAt: qs.engineStateChangedAt,
    engineStatePeakScore: qs.engineStatePeakScore,
    decayFactor: qs.decayFactor,

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
    mode: qs.mode ?? null,
    hrFactors: raw?.hrFactors ?? null,
    hrBuildScore: raw?.hrBuildScore ?? null,
    hrIntensity: raw?.hrIntensity ?? null,
    rollingForm: qs.rollingForm ?? null,

    pitcherAnalysis: qs.pitcherAnalysis ?? raw?.pitcherAnalysis ?? null,
    pitcherSignals: qs.pitcherSignals ?? raw?.pitcherSignals ?? null,

    opportunityScore: qs.opportunityScore ?? 0,
    liveScore: qs.liveScore ?? 0,
    eventBoost: qs.eventBoost ?? 0,

    smartTags,
    primaryReason,
    pitchMatchupRatings,

    // Phase C: pass the engine diagnostics envelope through to the wire
    // shape verbatim. Older cached signals without this field simply yield
    // undefined, which is the correct "no diagnostics available" state.
    diagnostics: qs.diagnostics,
  };
}

/**
 * Public entry point: normalize a quickSignal into a wire-shaped MLBSignal
 * AND stamp the MLB Canonical Display Contract. Every consumer that calls
 * normalizeMLBSignal automatically receives the contract fields — there is
 * no opt-in path that bypasses them.
 */
export function normalizeMLBSignal(
  qs: Record<string, any>,
  ctx: NormalizeContext,
): MLBSignal {
  const base = buildBaseMLBSignal(qs, ctx);
  return applyDisplayContract(base, qs);
}

/**
 * Stamp the MLB Canonical Display Contract onto a normalized signal.
 *
 * Pure transform: takes a fully normalized MLBSignal (post-`normalizeMLBSignal`)
 * plus the server-derived signalTier and produces the same signal augmented
 * with displaySide / displayProbability / overProbability / underProbability /
 * displayGrade / isBettable / isWatchOnly / displayDrivers.
 *
 * The display contract is the SOLE source of truth for client rendering:
 *   - clients MUST NOT derive grade from signalScore or liveScore
 *   - clients MUST NOT derive bettability from probability alone
 *   - clients MUST NOT default selected side to OVER when displaySide=UNDER
 *
 * Logs `[MLB_DISPLAY_CONTRACT_MISMATCH]` when the engine's recommended side
 * disagrees with the higher of OVER/UNDER probability (e.g. recommendedSide=
 * OVER at 32% probability), or when bettable+low-prob combinations slip
 * through. These logs are admin-only diagnostics.
 */
export function applyDisplayContract(
  sig: MLBSignal,
  qs: Record<string, any>,
): MLBSignal {
  // Sided post-cap probabilities from the calibrator. Fall back to enginePct
  // for the recommended side (Phase 1 canonical), and complement for the
  // opposite side, when paired calibration isn't available.
  const recSide = (sig.recommendedSide === "UNDER" ? "UNDER" : "OVER") as "OVER" | "UNDER";
  const overProb = sig.calibratedProbabilityOver != null
    ? Math.round(sig.calibratedProbabilityOver * 10) / 10
    : (recSide === "OVER" ? sig.enginePct : Math.max(0, Math.min(100, 100 - sig.enginePct)));
  const underProb = sig.calibratedProbabilityUnder != null
    ? Math.round(sig.calibratedProbabilityUnder * 10) / 10
    : (recSide === "UNDER" ? sig.enginePct : Math.max(0, Math.min(100, 100 - sig.enginePct)));

  const displaySide: "OVER" | "UNDER" = recSide;
  const displayProbability = displaySide === "OVER" ? overProb : underProb;
  const tier: "watch" | "lean" | "strong" | "elite" = sig.signalTier ?? "watch";
  const displayGrade = deriveDisplayGrade(tier, sig.signalScore ?? 0);
  const isBettable = displayProbability >= 50 && (tier as string) !== "watch";
  const isWatchOnly = !isBettable || (tier as string) === "watch";
  const displayDrivers = buildDisplayDrivers(qs, sig.market);

  // Mismatch diagnostics. These NEVER affect what the user sees — they only
  // surface internal disagreements between engine outputs and the display
  // contract so the orchestrator team can fix them at the engine layer.
  const oppositeProb = displaySide === "OVER" ? underProb : overProb;
  const mismatchReasons: string[] = [];
  if (displayProbability < 50 && isBettable) {
    mismatchReasons.push("bettable_below_50");
  }
  if (oppositeProb > displayProbability + 5) {
    mismatchReasons.push("recommended_side_lower_probability");
  }
  if (displayGrade === "A+" && (sig.signalScore ?? 0) < 80) {
    mismatchReasons.push("a_plus_low_score");
  }
  if (mismatchReasons.length > 0) {
    try {
      console.log("[MLB_DISPLAY_CONTRACT_MISMATCH]", {
        player: sig.playerName,
        market: sig.market,
        displaySide,
        recommendedSide: sig.recommendedSide,
        displayProbability,
        overProbability: overProb,
        underProbability: underProb,
        signalScore: sig.signalScore,
        signalTier: tier,
        displayGrade,
        isBettable,
        reason: mismatchReasons.join(","),
      });
    } catch {}
  }

  return {
    ...sig,
    displaySide,
    displayProbability,
    overProbability: overProb,
    underProbability: underProb,
    displayGrade,
    isBettable,
    isWatchOnly,
    displayDrivers,
  };
}
