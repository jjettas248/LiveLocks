import type { HRBuildResult, ClassifiedContact } from "./HRSignalBuilder";
import { classifyContactEvent } from "./HRSignalBuilder";
import { computeHRConversionProbability, type HRConversionInput, type HRConversionResult, type PitcherDeteriorationContext } from "./hrConversionModel";

export type HRAlertLevel = "ALERT" | "WATCH" | null;
export type HRSignalState = "PEAK" | "BUILDING" | "FORMATION" | "COOLDOWN" | null;
export type HRDecision = "BET_NOW" | "PREPARE" | "MONITOR" | null;
export type HRAlertTier = "officialAlert" | "prepare" | "watch" | null;

export interface HRAlertInput {
  playerId: string;
  playerName: string;
  teamAbbr: string;
  gameId: string;
  hrBuildScore: number;
  hrIntensity: string;
  factors: HRBuildResult["factors"];
  inning: number;
  isTopInning?: boolean;
  battingOrderSlot?: number;
  remainingPA?: number;
  pitchCount?: number;
  timesThrough?: number;
  isPitcherCollapsing?: boolean;
  parkFactor?: number;
  windDirection?: string | null;
  windSpeed?: number | null;
  temperature?: number | null;
  isIndoors?: boolean;
  batterHand?: string | null;
  pitcherThrows?: string | null;
  era?: number | null;
  currentRuns?: number;
  leagueAvgRuns?: number;
  seasonHRRate?: number | null;
  barrelRate?: number | null;
  hardHitRate?: number | null;
  xSLG?: number | null;
  pitcherDeterioration?: PitcherDeteriorationContext | null;
  priorABResults: Array<{
    exitVelocity: number | null;
    launchAngle: number | null;
    distance: number | null;
    outcome: string;
  }>;
}

export interface HRSuppressionFlag {
  reason: string;
  severity: "hard" | "soft";
}

export interface HRAlertDiagnostics {
  alertPath: string | null;
  positiveFactors: string[];
  suppressionFlags: HRSuppressionFlag[];
  hrShapedCount: number;
  missedHrCount: number;
  eliteHrCount: number;
  qualifiedEVMean: number | null;
  maxDistance: number | null;
  remainingPA: number | null;
  pitcherFatigueState: string;
  environmentContext: string;
  contactClasses: ClassifiedContact[];
  hrConversion: HRConversionResult | null;
}

export interface HRAlertResult {
  level: HRAlertLevel;
  triggerReason: string;
  signalState: HRSignalState;
  decision: HRDecision;
  confidenceScore: number;
  formattedReason: string;
  detectedInning: number;
  alertTier: HRAlertTier;
  diagnostics: HRAlertDiagnostics;
}

const COOLDOWN_MS = 10 * 60 * 1000;
const recentAlerts = new Map<string, number>();

function cooldownKey(playerId: string, gameId: string): string {
  return `${playerId}:${gameId}`;
}

export function isOnCooldown(playerId: string, gameId: string): boolean {
  const key = cooldownKey(playerId, gameId);
  const last = recentAlerts.get(key);
  if (!last) return false;
  return Date.now() - last < COOLDOWN_MS;
}

export function markAlertSent(playerId: string, gameId: string): void {
  recentAlerts.set(cooldownKey(playerId, gameId), Date.now());
}

export function clearGameCooldowns(gameId: string): void {
  const keys = Array.from(recentAlerts.keys());
  for (const key of keys) {
    if (key.endsWith(`:${gameId}`)) recentAlerts.delete(key);
  }
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function describePitcherState(input: HRAlertInput): string {
  const parts: string[] = [];
  if (input.pitchCount != null && input.pitchCount >= 75) parts.push(`PC=${input.pitchCount}`);
  if (input.timesThrough != null && input.timesThrough >= 3) parts.push(`TTO=${input.timesThrough}`);
  if (input.isPitcherCollapsing) parts.push("COLLAPSING");
  if (input.era != null && input.era >= 5.0) parts.push(`ERA=${input.era}`);
  const det = input.pitcherDeterioration;
  if (det) {
    if (det.velocityDrop !== null && det.velocityDrop > 2) parts.push(`veloDrop=${det.velocityDrop.toFixed(1)}`);
    if (det.isReliever) parts.push("reliever");
    if (det.relieverEra !== null && det.relieverEra >= 5.0) parts.push(`rlvERA=${det.relieverEra.toFixed(2)}`);
    if (det.bullpenEra !== null && det.bullpenEra >= 5.0) parts.push(`bpERA=${det.bullpenEra.toFixed(2)}`);
    if (det.bullpenUsageLast3Days !== null && det.bullpenUsageLast3Days >= 80) parts.push("tired-bp");
  }
  return parts.length > 0 ? parts.join(", ") : "stable";
}

function describeEnvironment(input: HRAlertInput): string {
  const parts: string[] = [];
  if (input.parkFactor != null && input.parkFactor >= 1.05) parts.push(`PF=${input.parkFactor}`);
  if (input.windDirection === "out" && (input.windSpeed ?? 0) >= 8) parts.push(`wind-out ${input.windSpeed}mph`);
  if (input.windDirection === "in" && (input.windSpeed ?? 0) >= 10) parts.push(`wind-in ${input.windSpeed}mph`);
  if (input.temperature != null && input.temperature >= 85) parts.push(`${input.temperature}°F`);
  return parts.length > 0 ? parts.join(", ") : "neutral";
}

function buildSuppression(input: HRAlertInput, classified: ClassifiedContact[]): HRSuppressionFlag[] {
  const flags: HRSuppressionFlag[] = [];
  const remainingPA = input.remainingPA ?? null;
  const hrShaped = classified.filter(c =>
    c.contactClass === "hrShapedContact" ||
    c.contactClass === "missedHrContact" ||
    c.contactClass === "eliteHrContact"
  );
  const hasEliteOrMissed = classified.some(c =>
    c.contactClass === "missedHrContact" || c.contactClass === "eliteHrContact"
  );

  if (remainingPA !== null && remainingPA < 1.0 && !hasEliteOrMissed) {
    flags.push({ reason: `remainingPA too low (${remainingPA.toFixed(1)}) without elite evidence`, severity: "hard" });
  }

  if (hrShaped.length === 1) {
    const singleEvent = hrShaped[0];
    const abIndex = classified.indexOf(singleEvent);
    const totalABs = classified.length;
    if (abIndex === 0 && totalABs >= 3 && singleEvent.contactClass === "hrShapedContact") {
      flags.push({ reason: "single HR-shaped event from early AB with no repeat confirmation", severity: "soft" });
    }
  }

  const laValues = classified.filter(c => c.exitVelocity >= 95).map(c => c.launchAngle);
  if (laValues.length >= 2) {
    const avgLA = laValues.reduce((s, v) => s + v, 0) / laValues.length;
    if (avgLA > 42 || avgLA < 15) {
      flags.push({ reason: `LA profile inconsistent for HR (avg ${avgLA.toFixed(0)}° across hard-hit events)`, severity: "soft" });
    }
  }

  if (!input.isIndoors && input.windDirection === "in" && (input.windSpeed ?? 0) >= 10) {
    flags.push({ reason: `headwind suppression (in ${input.windSpeed}mph)`, severity: "soft" });
  }

  if (input.batterHand && input.pitcherThrows && input.batterHand === input.pitcherThrows) {
    flags.push({ reason: `same-side matchup (${input.batterHand}v${input.pitcherThrows})`, severity: "soft" });
  }

  if (input.temperature != null && input.temperature <= 45) {
    flags.push({ reason: `cold temperature suppression (${input.temperature}°F)`, severity: "soft" });
  }

  return flags;
}

function formatReason(alertPath: string, factors: HRBuildResult["factors"], inning: number, convProb: number | null): string {
  const convStr = convProb !== null ? ` Conv ${(convProb * 100).toFixed(0)}%.` : "";
  if (alertPath === "PATH_A") {
    return `Repeated HR-shaped contact (${factors.hrShapedCount} events, mean EV ${factors.qualifiedEVMean ?? "?"}mph).${convStr} HR conversion elevated into ${ordinal(inning)} inning.`;
  }
  if (alertPath === "PATH_B") {
    const desc = factors.eliteHrCount > 0 ? "elite HR-shaped" : "near-miss HR";
    return `${desc} event detected with favorable pitcher/environment context.${convStr} Live HR conversion window active.`;
  }
  if (alertPath === "PATH_C") {
    return `Late-game power build (${ordinal(inning)} inning).${convStr} HR-shaped contact maintained with improved matchup context.`;
  }
  return "HR conversion indicators active — monitoring.";
}

function computeConfidence(
  hrBuildScore: number,
  factors: HRBuildResult["factors"],
  alertPath: string | null,
  suppressionCount: number,
  convProb: number | null
): number {
  let base = Math.min(10, Math.round(hrBuildScore * 1.5));

  if (factors.eliteHrCount >= 1) base = Math.min(10, base + 2);
  else if (factors.missedHrCount >= 1) base = Math.min(10, base + 1);

  if (factors.hrShapedCount >= 2) base = Math.min(10, base + 1);

  if ((factors.qualifiedEVMean ?? 0) >= 102) base = Math.min(10, base + 1);

  if (convProb !== null) {
    if (convProb >= 0.20) base = Math.min(10, base + 2);
    else if (convProb >= 0.15) base = Math.min(10, base + 1);
    else if (convProb < 0.08) base = Math.max(1, base - 1);
  }

  base = Math.max(1, base - suppressionCount);

  return Math.max(1, base);
}

const HR_CONVERSION_ALERT_MIN = 0.08;
const HR_CONVERSION_OFFICIAL_MIN = 0.12;
const HR_CONVERSION_WATCH_MIN = 0.05;

function buildConversionInput(input: HRAlertInput): HRConversionInput {
  return {
    hrBuildScore: input.hrBuildScore,
    factors: input.factors,
    inning: input.inning,
    isTopInning: input.isTopInning ?? true,
    battingOrderSlot: input.battingOrderSlot ?? 5,
    currentRuns: input.currentRuns ?? 4.5,
    leagueAvgRuns: input.leagueAvgRuns ?? 4.5,
    pitchCount: input.pitchCount ?? 0,
    timesThrough: input.timesThrough ?? 1,
    isPitcherCollapsing: input.isPitcherCollapsing ?? false,
    era: input.era ?? null,
    parkFactor: input.parkFactor ?? 1.0,
    windDirection: input.windDirection ?? null,
    windSpeed: input.windSpeed ?? null,
    temperature: input.temperature ?? null,
    isIndoors: input.isIndoors ?? false,
    batterHand: input.batterHand ?? null,
    pitcherThrows: input.pitcherThrows ?? null,
    seasonHRRate: input.seasonHRRate ?? null,
    barrelRate: input.barrelRate ?? null,
    hardHitRate: input.hardHitRate ?? null,
    xSLG: input.xSLG ?? null,
    pitcherDeterioration: input.pitcherDeterioration ?? null,
  };
}

export function evaluateHRAlert(input: HRAlertInput): HRAlertResult {
  const { hrBuildScore, factors, inning, priorABResults } = input;

  const classified = priorABResults.map(ab => classifyContactEvent(ab));

  const hrShapedCount = factors.hrShapedCount ?? 0;
  const missedHrCount = factors.missedHrCount ?? 0;
  const eliteHrCount = factors.eliteHrCount ?? 0;
  const qualifiedEVMean = factors.qualifiedEVMean ?? null;
  const maxDistance = factors.maxDistance ?? null;
  const remainingPA = input.remainingPA ?? null;

  const suppressionFlags = buildSuppression(input, classified);
  const hardVetoes = suppressionFlags.filter(f => f.severity === "hard");
  const softVetoes = suppressionFlags.filter(f => f.severity === "soft");

  const pitcherFatigueState = describePitcherState(input);
  const environmentContext = describeEnvironment(input);

  let hrConversion: HRConversionResult | null = null;
  try {
    const convInput = buildConversionInput(input);
    hrConversion = computeHRConversionProbability(convInput);
  } catch (err: any) {
    console.warn(`[HR_CONVERSION] computation failed for ${input.playerName}: ${err.message}`);
  }

  const convProb = hrConversion?.calibratedProbability ?? hrConversion?.hrConversionProbability ?? null;

  const baseDiagnostics: HRAlertDiagnostics = {
    alertPath: null,
    positiveFactors: [],
    suppressionFlags,
    hrShapedCount,
    missedHrCount,
    eliteHrCount,
    qualifiedEVMean,
    maxDistance,
    remainingPA,
    pitcherFatigueState,
    environmentContext,
    contactClasses: classified,
    hrConversion,
  };

  const nullResult: HRAlertResult = {
    level: null,
    triggerReason: "",
    signalState: null,
    decision: null,
    confidenceScore: 0,
    formattedReason: "",
    detectedInning: inning,
    alertTier: null,
    diagnostics: baseDiagnostics,
  };

  if (isOnCooldown(input.playerId, input.gameId)) {
    return {
      ...nullResult,
      triggerReason: "cooldown",
      signalState: "COOLDOWN",
      confidenceScore: computeConfidence(hrBuildScore, factors, null, softVetoes.length, convProb),
      formattedReason: "Recently alerted — signal on cooldown. Monitoring for re-escalation.",
      diagnostics: { ...baseDiagnostics, alertPath: "COOLDOWN" },
    };
  }

  if (hardVetoes.length > 0) {
    const reasons = hardVetoes.map(v => v.reason).join("; ");
    console.log(`[HR_ALERT_VETO] ${input.playerName} game=${input.gameId} — hard veto: ${reasons}`);
    return {
      ...nullResult,
      diagnostics: {
        ...baseDiagnostics,
        alertPath: "VETOED",
        positiveFactors: [],
      },
    };
  }

  if (convProb !== null && convProb < HR_CONVERSION_WATCH_MIN) {
    console.log(`[HR_ALERT_CONV_GATE] ${input.playerName} game=${input.gameId} — convProb=${(convProb * 100).toFixed(1)}% below watch min ${(HR_CONVERSION_WATCH_MIN * 100).toFixed(0)}%. Suppressing.`);
    return {
      ...nullResult,
      diagnostics: {
        ...baseDiagnostics,
        alertPath: "CONV_LOW",
        positiveFactors: [],
      },
    };
  }

  const totalHrShaped = hrShapedCount;
  const hasMissedOrElite = missedHrCount > 0 || eliteHrCount > 0;

  const pitcherFavorable = (input.pitchCount ?? 0) >= 75 ||
    (input.timesThrough ?? 0) >= 3 ||
    input.isPitcherCollapsing === true ||
    (input.era != null && input.era >= 4.5);

  const envFavorable = (input.parkFactor ?? 1.0) >= 1.05 ||
    (input.windDirection === "out" && (input.windSpeed ?? 0) >= 8);

  const hasStrongContext = pitcherFavorable && envFavorable;
  const hasModerateContext = pitcherFavorable || envFavorable;

  const positiveFactors: string[] = [];
  const convPct = convProb !== null ? `${(convProb * 100).toFixed(1)}%` : "n/a";

  if (
    totalHrShaped >= 2 &&
    (qualifiedEVMean ?? 0) >= 99 &&
    (maxDistance ?? 0) >= 375 &&
    (remainingPA === null || remainingPA >= 1.3) &&
    softVetoes.length === 0 &&
    (convProb === null || convProb >= HR_CONVERSION_ALERT_MIN)
  ) {
    positiveFactors.push(`${totalHrShaped} HR-shaped events`);
    positiveFactors.push(`qualified EV mean ${qualifiedEVMean}mph`);
    positiveFactors.push(`max distance ${maxDistance}ft`);
    positiveFactors.push(`conversion: ${convPct}`);
    if (pitcherFavorable) positiveFactors.push(`pitcher: ${pitcherFatigueState}`);
    if (envFavorable) positiveFactors.push(`env: ${environmentContext}`);

    const conf = computeConfidence(hrBuildScore, factors, "PATH_A", softVetoes.length, convProb);
    const isOfficial = convProb === null || convProb >= HR_CONVERSION_OFFICIAL_MIN;
    console.log(`[HR_ALERT_PATH_A] ${input.playerName} game=${input.gameId} hrShaped=${totalHrShaped} evMean=${qualifiedEVMean} maxDist=${maxDistance} score=${hrBuildScore} conv=${convPct} conf=${conf}`);

    return {
      level: "ALERT",
      triggerReason: `PATH_A:${totalHrShaped}xHrShaped_evMean${qualifiedEVMean}_dist${maxDistance}`,
      signalState: isOfficial ? "PEAK" : "BUILDING",
      decision: isOfficial ? "BET_NOW" : "PREPARE",
      confidenceScore: conf,
      formattedReason: formatReason("PATH_A", factors, inning, convProb),
      detectedInning: inning,
      alertTier: isOfficial ? "officialAlert" : "prepare",
      diagnostics: { ...baseDiagnostics, alertPath: "PATH_A", positiveFactors },
    };
  }

  if (
    totalHrShaped >= 2 &&
    (remainingPA === null || remainingPA >= 1.0) &&
    softVetoes.length <= 1 &&
    (convProb === null || convProb >= HR_CONVERSION_ALERT_MIN)
  ) {
    positiveFactors.push(`${totalHrShaped} HR-shaped events`);
    if (qualifiedEVMean != null) positiveFactors.push(`qualified EV mean ${qualifiedEVMean}mph`);
    positiveFactors.push(`conversion: ${convPct}`);
    if (pitcherFavorable) positiveFactors.push(`pitcher: ${pitcherFatigueState}`);

    const conf = computeConfidence(hrBuildScore, factors, "PATH_A", softVetoes.length, convProb);
    const isOfficial = softVetoes.length === 0 && hrBuildScore >= 4.0 && (convProb === null || convProb >= HR_CONVERSION_OFFICIAL_MIN);

    return {
      level: "ALERT",
      triggerReason: `PATH_A:${totalHrShaped}xHrShaped_score${hrBuildScore}`,
      signalState: isOfficial ? "PEAK" : "BUILDING",
      decision: isOfficial ? "BET_NOW" : "PREPARE",
      confidenceScore: conf,
      formattedReason: formatReason("PATH_A", factors, inning, convProb),
      detectedInning: inning,
      alertTier: isOfficial ? "officialAlert" : "prepare",
      diagnostics: { ...baseDiagnostics, alertPath: "PATH_A", positiveFactors },
    };
  }

  if (
    hasMissedOrElite &&
    hasModerateContext &&
    (remainingPA === null || remainingPA >= 1.0) &&
    (convProb === null || convProb >= HR_CONVERSION_ALERT_MIN)
  ) {
    positiveFactors.push(eliteHrCount > 0 ? `${eliteHrCount} elite HR contact` : `${missedHrCount} missed HR contact`);
    positiveFactors.push(`conversion: ${convPct}`);
    if (pitcherFavorable) positiveFactors.push(`pitcher: ${pitcherFatigueState}`);
    if (envFavorable) positiveFactors.push(`env: ${environmentContext}`);

    const isOfficial = hasStrongContext && softVetoes.length === 0 && hrBuildScore >= 4.0 && (convProb === null || convProb >= HR_CONVERSION_OFFICIAL_MIN);
    const conf = computeConfidence(hrBuildScore, factors, "PATH_B", softVetoes.length, convProb);

    return {
      level: "ALERT",
      triggerReason: `PATH_B:${eliteHrCount > 0 ? "elite" : "missedHr"}+context`,
      signalState: isOfficial ? "PEAK" : "BUILDING",
      decision: isOfficial ? "BET_NOW" : "PREPARE",
      confidenceScore: conf,
      formattedReason: formatReason("PATH_B", factors, inning, convProb),
      detectedInning: inning,
      alertTier: isOfficial ? "officialAlert" : "prepare",
      diagnostics: { ...baseDiagnostics, alertPath: "PATH_B", positiveFactors },
    };
  }

  if (
    inning >= 5 &&
    totalHrShaped >= 1 &&
    pitcherFavorable &&
    (remainingPA === null || remainingPA >= 1.0) &&
    hrBuildScore >= 4.0 &&
    (convProb === null || convProb >= HR_CONVERSION_ALERT_MIN)
  ) {
    positiveFactors.push(`late-game (${ordinal(inning)} inning)`);
    positiveFactors.push(`${totalHrShaped} HR-shaped events`);
    positiveFactors.push(`conversion: ${convPct}`);
    positiveFactors.push(`pitcher: ${pitcherFatigueState}`);

    const isOfficial = totalHrShaped >= 2 && softVetoes.length === 0 && (convProb === null || convProb >= HR_CONVERSION_OFFICIAL_MIN);
    const conf = computeConfidence(hrBuildScore, factors, "PATH_C", softVetoes.length, convProb);

    return {
      level: "ALERT",
      triggerReason: `PATH_C:inn${inning}_hrShaped${totalHrShaped}_pitcher_favorable`,
      signalState: isOfficial ? "PEAK" : "BUILDING",
      decision: isOfficial ? "BET_NOW" : "PREPARE",
      confidenceScore: conf,
      formattedReason: formatReason("PATH_C", factors, inning, convProb),
      detectedInning: inning,
      alertTier: isOfficial ? "officialAlert" : "prepare",
      diagnostics: { ...baseDiagnostics, alertPath: "PATH_C", positiveFactors },
    };
  }

  if (
    totalHrShaped >= 1 &&
    hrBuildScore >= 3.5 &&
    (remainingPA === null || remainingPA >= 1.0) &&
    (convProb === null || convProb >= HR_CONVERSION_WATCH_MIN)
  ) {
    positiveFactors.push(`${totalHrShaped} HR-shaped events, score=${hrBuildScore}`);
    positiveFactors.push(`conversion: ${convPct}`);

    return {
      level: "WATCH",
      triggerReason: `watch:hrShaped${totalHrShaped}_score${hrBuildScore}`,
      signalState: "FORMATION",
      decision: "MONITOR",
      confidenceScore: computeConfidence(hrBuildScore, factors, null, softVetoes.length, convProb),
      formattedReason: `HR-shaped contact detected (conv ${convPct}). Monitoring for escalation — need repeat confirmation or stronger context.`,
      detectedInning: inning,
      alertTier: "watch",
      diagnostics: { ...baseDiagnostics, alertPath: "WATCH", positiveFactors },
    };
  }

  if (
    totalHrShaped === 0 &&
    (factors.barrels >= 1 || factors.hardHits >= 1 || factors.deepFlyouts >= 1) &&
    hrBuildScore >= 2.5
  ) {
    console.log(`[HR_ALERT_BLOCKED] ${input.playerName} game=${input.gameId} — power indicators (barrels=${factors.barrels} hardHits=${factors.hardHits} deepFly=${factors.deepFlyouts}) but no HR-shaped contact. Score=${hrBuildScore} conv=${convPct}. NOT alerting.`);
  }

  return nullResult;
}
