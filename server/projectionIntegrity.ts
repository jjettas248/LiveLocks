export type ProjectionSource =
  | "engine_live_context"
  | "engine_live_plus_baseline"
  | "baseline_only"
  | "fallback_static";

export type ProjectionQuality = "high" | "medium" | "low";

export interface ProjectionIntegrity {
  projectionSource: ProjectionSource;
  projectionQuality: ProjectionQuality;
  fallbackUsed: boolean;
  projectionWarnings: string[];
  sourceDataCompleteness: number;
  projectionTrustScore: number;
  confidenceReason: string;
}

export interface NBAProjectionTrust extends ProjectionIntegrity {
  minutesTrustScore: number;
  roleTrustScore: number;
  projectedRemainingStat: number;
  fullProjection: number;
}

export interface MLBProjectionTrust extends ProjectionIntegrity {
  marketValidationPassed: boolean;
  remainingOpportunity: number;
  baselineWeight: number;
  liveWeight: number;
  overRegressionApplied: boolean;
}

export function assessMLBProjectionIntegrity(opts: {
  seasonAvg: number;
  market: string;
  remainingAB: number;
  currentStatValue: number;
  hasLiveContactData: boolean;
  fallbackUsed: boolean;
  projection: number;
  line: number;
  side: string;
}): MLBProjectionTrust {
  const warnings: string[] = [];
  let completeness = 1.0;

  if (opts.seasonAvg <= 0) {
    completeness -= 0.4;
    warnings.push(`no_season_data_for_${opts.market}`);
  }

  if (opts.remainingAB <= 1) {
    completeness -= 0.2;
    warnings.push("low_remaining_opportunity");
  }

  if (!opts.hasLiveContactData) {
    completeness -= 0.1;
    warnings.push("no_live_contact_data");
  }

  completeness = Math.max(0, Math.min(1, completeness));

  let source: ProjectionSource;
  if (opts.fallbackUsed) {
    source = "fallback_static";
  } else if (opts.hasLiveContactData && opts.seasonAvg > 0) {
    source = "engine_live_context";
  } else if (opts.seasonAvg > 0) {
    source = "engine_live_plus_baseline";
  } else {
    source = "baseline_only";
  }

  let quality: ProjectionQuality;
  if (completeness >= 0.8 && !opts.fallbackUsed) {
    quality = "high";
  } else if (completeness >= 0.5 && !opts.fallbackUsed) {
    quality = "medium";
  } else {
    quality = "low";
  }

  const isOver = opts.side === "OVER";
  const projectionClearsLine = isOver
    ? opts.projection > opts.line
    : opts.projection < opts.line;
  const clearance = Math.abs(opts.projection - opts.line);
  const clearancePct = opts.line > 0 ? clearance / opts.line : 0;

  let trustScore = completeness * 0.5;
  if (projectionClearsLine) trustScore += 0.2;
  if (clearancePct > 0.1) trustScore += 0.1;
  if (!opts.fallbackUsed) trustScore += 0.1;
  if (opts.remainingAB >= 3) trustScore += 0.1;
  trustScore = Math.max(0, Math.min(1, trustScore));

  const overRegression = isOver && quality !== "high";

  const marketGates: Record<string, boolean> = {
    hits: quality !== "low" || !isOver,
    total_bases: (quality === "high" || quality === "medium") || !isOver,
    home_runs: quality !== "low" && opts.remainingAB >= 2,
    pitcher_strikeouts: quality !== "low",
    batter_strikeouts: true,
    hits_allowed: true,
    walks_allowed: true,
    pitcher_outs: true,
    hr_allowed: true,
    hrr: quality !== "low",
  };
  const marketPassed = marketGates[opts.market] ?? true;

  if (!marketPassed) {
    warnings.push(`market_validation_failed_${opts.market}`);
  }

  let reason = `source=${source}`;
  if (opts.fallbackUsed) reason += ",fallback";
  if (!marketPassed) reason += ",market_gate_failed";
  if (overRegression) reason += ",over_regression";

  return {
    projectionSource: source,
    projectionQuality: quality,
    fallbackUsed: opts.fallbackUsed,
    projectionWarnings: warnings,
    sourceDataCompleteness: Math.round(completeness * 100) / 100,
    projectionTrustScore: Math.round(trustScore * 100) / 100,
    confidenceReason: reason,
    marketValidationPassed: marketPassed,
    remainingOpportunity: opts.remainingAB,
    baselineWeight: 0.70,
    liveWeight: 0.30,
    overRegressionApplied: overRegression,
  };
}

export function assessNBAProjectionIntegrity(opts: {
  minutesExpected: number;
  minutesVariance: number;
  minutesPlayed: number;
  recentGameCount: number;
  fragilityScore: number;
  archetype: string;
  projection: number;
  line: number;
  direction: string;
  mu: number;
  currentStat: number;
  rateDataPresent: boolean;
}): NBAProjectionTrust {
  const warnings: string[] = [];
  let completeness = 1.0;

  if (!opts.rateDataPresent) {
    completeness -= 0.3;
    warnings.push("missing_rate_data");
  }
  if (opts.recentGameCount < 3) {
    completeness -= 0.2;
    warnings.push("thin_recent_sample");
  }
  if (opts.minutesExpected < 10) {
    completeness -= 0.15;
    warnings.push("low_expected_minutes");
  }

  completeness = Math.max(0, Math.min(1, completeness));

  const minutesTrust = Math.max(0, 1 - opts.minutesVariance / 100);
  const roleTrust = Math.max(0, 1 - opts.fragilityScore);

  let source: ProjectionSource;
  if (opts.rateDataPresent && opts.recentGameCount >= 5) {
    source = "engine_live_context";
  } else if (opts.rateDataPresent) {
    source = "engine_live_plus_baseline";
  } else {
    source = "baseline_only";
  }

  let quality: ProjectionQuality;
  if (completeness >= 0.8 && minutesTrust >= 0.5 && roleTrust >= 0.5) {
    quality = "high";
  } else if (completeness >= 0.5 && minutesTrust >= 0.3) {
    quality = "medium";
  } else {
    quality = "low";
  }

  const isOver = opts.direction === "OVER";
  const projectionClearsLine = isOver
    ? opts.projection > opts.line
    : opts.projection < opts.line;

  let trustScore = completeness * 0.3 + minutesTrust * 0.25 + roleTrust * 0.25;
  if (projectionClearsLine) trustScore += 0.1;
  if (opts.recentGameCount >= 5) trustScore += 0.1;
  trustScore = Math.max(0, Math.min(1, trustScore));

  const fallbackUsed = !opts.rateDataPresent;
  let reason = `source=${source},minTrust=${minutesTrust.toFixed(2)},roleTrust=${roleTrust.toFixed(2)}`;
  if (fallbackUsed) reason += ",fallback";

  return {
    projectionSource: source,
    projectionQuality: quality,
    fallbackUsed,
    projectionWarnings: warnings,
    sourceDataCompleteness: Math.round(completeness * 100) / 100,
    projectionTrustScore: Math.round(trustScore * 100) / 100,
    confidenceReason: reason,
    minutesTrustScore: Math.round(minutesTrust * 100) / 100,
    roleTrustScore: Math.round(roleTrust * 100) / 100,
    projectedRemainingStat: opts.mu,
    fullProjection: opts.projection,
  };
}

export type ExpansionTier = "A" | "B" | "C" | "REJECT";

export function assignExpansionTier(
  trustScore: number,
  probability: number,
  fallbackUsed: boolean,
  marketValidationPassed: boolean,
): ExpansionTier {
  if (!marketValidationPassed) return "REJECT";
  if (fallbackUsed && trustScore < 0.4) return "REJECT";

  if (trustScore >= 0.7 && probability >= 62 && !fallbackUsed) return "A";
  if (trustScore >= 0.5 && probability >= 58) return "B";
  if (trustScore >= 0.3 && probability >= 55) return "C";
  return "REJECT";
}

export function deriveConfidenceFromTrust(
  probability: number,
  trustScore: number,
  fallbackUsed: boolean,
  marketValidationPassed: boolean,
  quality: ProjectionQuality,
): "ELITE" | "STRONG" | "VALUE" | "NO_EDGE" {
  if (!marketValidationPassed) return "NO_EDGE";
  if (fallbackUsed && quality === "low") return "NO_EDGE";

  if (probability >= 75 && trustScore >= 0.65 && quality !== "low" && !fallbackUsed) {
    return "ELITE";
  }
  if (probability >= 65 && trustScore >= 0.5 && quality !== "low") {
    return "STRONG";
  }
  if (probability >= 58 && trustScore >= 0.3) {
    return "VALUE";
  }
  return "NO_EDGE";
}
