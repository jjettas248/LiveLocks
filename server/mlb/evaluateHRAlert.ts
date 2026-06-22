import type { HRBuildResult, ClassifiedContact } from "./HRSignalBuilder";
import { classifyContactEvent } from "./HRSignalBuilder";
import { computeHRConversionProbability, type HRConversionInput, type HRConversionResult, type PitcherDeteriorationContext } from "./hrConversionModel";
import type { MLBBatterArchetype } from "./archetypes";
import type { PitchMixEntry } from "./types";

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
  // Lane 3.1/3.2: weather density inputs (Open-Meteo). Optional — no-op when null.
  humidity?: number | null;
  pressure?: number | null;
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
  abSinceLastHR?: number | null;
  hrRateLast7?: number | null;
  hrRateLast15?: number | null;
  hrRateLast30?: number | null;
  handednessParkFactor?: number | null;
  pitcherDeterioration?: PitcherDeteriorationContext | null;
  leiNearHrScore?: number;
  leiMomentumScore?: number;
  leiPitcherFatigueScore?: number;
  leiVeloDropScore?: number;
  leiConfidenceBoost?: number;
  leiTags?: string[];
  priorABResults: Array<{
    exitVelocity: number | null;
    launchAngle: number | null;
    distance: number | null;
    outcome: string;
  }>;
  // ── Pre-HR danger layer (optional; fed in by buildHRSignal callers) ──
  preHrDangerScore?: number;
  dangerFlags?: string[];
  // Phase 3 — optional batter archetype
  batterArchetype?: MLBBatterArchetype | null;
  // Gap 1: in-game pitch mix for handedness × pitch-type multiplier
  pitchMix?: PitchMixEntry[] | null;
  // Gap 3: pre-game pitcher entry fatigue
  lastStartPitchCount?: number | null;
  daysSinceLastStart?: number | null;
  last3StartERA?: number | null;
  // Gap 4: empirical pitcher ERA/HR rate by batter handedness
  pitcherHandednessSplits?: import("./types").PitcherHandednessSplits | null;
  // Gap 5: batter HR rate vs this pitcher's hand
  batterHandednessSplits?: import("./types").BatterHandednessSplits | null;
  // Gaps 7–9: Savant power profile
  flyBallPercent?: number | null;
  hrFBRatio?: number | null;
  xwOBA?: number | null;
  xISO?: number | null;
  sweetSpotPercent?: number | null;
  // SlateRadar gap #6: batter pull rate (% BIP to pull side).
  pullRatePercent?: number | null;
  // Recent form: broader AVG/OPS form to pair with the existing hrRateLast* fields.
  recentOps?: number | null;   // L15 OPS
  seasonOps?: number | null;
  // IBB feared-slugger prior: season IBB rate + in-game base/out leverage context.
  seasonIBBRate?: number | null;   // IBB / PA
  firstBaseOpen?: boolean | null;
  runnerInScoringPosition?: boolean | null;
  scoreDifferential?: number | null;
  // Consolidated HR overlay (Phase 2 ingestion) — all optional, no-op when absent.
  maxEV?: number | null;
  toppedPercent?: number | null;
  seasonSLG?: number | null;
  recentSLG?: number | null;
  battingOrderSlgSplit?: number | null;
  pitchTypeSplits?: import("./hr/hrOverlayTypes").PitchTypeBatterSplit[] | null;
  // Phase 2 — market HR prop prices (American odds) for EV-gating the HR Max
  // Window tier. Optional and no-op when absent (HR-radar-only runs, pregame,
  // quota exhaustion) so partial odds coverage never suppresses signals.
  overOdds?: number | null;
  underOdds?: number | null;
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

// Daily slate-reset helper. Drops every cooldown entry whose gameId is not in
// the supplied active set. cooldownKey format: `${playerId}:${gameId}`.
export function clearStaleAlertCooldowns(activeGameIds: ReadonlySet<string>): number {
  let removed = 0;
  for (const key of Array.from(recentAlerts.keys())) {
    const sepIdx = key.lastIndexOf(":");
    const gameId = sepIdx >= 0 ? key.slice(sepIdx + 1) : key;
    if (!activeGameIds.has(gameId)) {
      recentAlerts.delete(key);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`[MLB_SLATE_RESET] evaluateHRAlert.recentAlerts pruned=${removed} kept=${recentAlerts.size}`);
  }
  return removed;
}

export function getRecentAlertsSize(): number {
  return recentAlerts.size;
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

  if (remainingPA !== null && remainingPA < 0.5 && !hasEliteOrMissed) {
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

function computeLeiBoost(input: HRAlertInput): { scoreBoost: number; escalate: boolean } {
  let scoreBoost = 0;
  let escalate = false;
  const near = input.leiNearHrScore ?? 0;
  const momentum = input.leiMomentumScore ?? 0;
  const fatigue = input.leiPitcherFatigueScore ?? 0;
  const velo = input.leiVeloDropScore ?? 0;
  const conf = input.leiConfidenceBoost ?? 0;

  if (near >= 0.08) { scoreBoost += 0.5; escalate = true; }
  if (momentum >= 0.05) scoreBoost += 0.3;
  if (fatigue >= 0.07) scoreBoost += 0.3;
  if (velo >= 0.06) scoreBoost += 0.2;
  if (conf >= 0.05) escalate = true;

  return { scoreBoost, escalate };
}

const HR_CONVERSION_ALERT_MIN = 0.08;
// Hit-rate tightening (2026-06): the official/ATTACK floor governs what becomes
// a committed, graded pick. Raise 0.12 → 0.15 so only genuinely top-tier
// conversion probabilities reach the HR Max Window. (§7a engine change.)
const HR_CONVERSION_OFFICIAL_MIN = 0.15;
const HR_CONVERSION_WATCH_MIN = 0.03;

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
    humidity: input.humidity ?? null,
    pressure: input.pressure ?? null,
    isIndoors: input.isIndoors ?? false,
    batterHand: input.batterHand ?? null,
    pitcherThrows: input.pitcherThrows ?? null,
    seasonHRRate: input.seasonHRRate ?? null,
    barrelRate: input.barrelRate ?? null,
    hardHitRate: input.hardHitRate ?? null,
    xSLG: input.xSLG ?? null,
    pitcherDeterioration: input.pitcherDeterioration ?? null,
    pitchMix: input.pitchMix ?? null,
    lastStartPitchCount: input.lastStartPitchCount ?? null,
    daysSinceLastStart: input.daysSinceLastStart ?? null,
    last3StartERA: input.last3StartERA ?? null,
    pitcherHandednessSplits: input.pitcherHandednessSplits ?? null,
    batterHandednessSplits: input.batterHandednessSplits ?? null,
    flyBallPercent: input.flyBallPercent ?? null,
    hrFBRatio: input.hrFBRatio ?? null,
    xwOBA: input.xwOBA ?? null,
    xISO: input.xISO ?? null,
    sweetSpotPercent: input.sweetSpotPercent ?? null,
    pullRatePercent: input.pullRatePercent ?? null,
    hrRateLast7: input.hrRateLast7 ?? null,
    hrRateLast15: input.hrRateLast15 ?? null,
    hrRateLast30: input.hrRateLast30 ?? null,
    recentOps: input.recentOps ?? null,
    seasonOps: input.seasonOps ?? null,
    seasonIBBRate: input.seasonIBBRate ?? null,
    firstBaseOpen: input.firstBaseOpen ?? null,
    runnerInScoringPosition: input.runnerInScoringPosition ?? null,
    scoreDifferential: input.scoreDifferential ?? null,
    // Consolidated HR overlay (Phase 2 ingestion).
    maxEV: input.maxEV ?? null,
    toppedPercent: input.toppedPercent ?? null,
    seasonSLG: input.seasonSLG ?? null,
    recentSLG: input.recentSLG ?? null,
    battingOrderSlgSplit: input.battingOrderSlgSplit ?? null,
    pitchTypeSplits: input.pitchTypeSplits ?? null,
  };
}

function evaluateHRAlertCore(input: HRAlertInput): HRAlertResult {
  const { hrBuildScore, factors, inning, priorABResults } = input;

  const classified = factors.contactClasses && factors.contactClasses.length > 0
    ? factors.contactClasses
    : priorABResults.map(ab => classifyContactEvent(ab));

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

  // In hitter-friendly parks during late innings, allow marginal hitters
  // (IKF pattern) to proceed with a 1.5% floor instead of 3%.
  // These batters can still HR on favorable pitches even with low base rates.
  const inningForConvGate = input.inning ?? 1;
  const parkFactorForConvGate = input.parkFactor ?? 1.0;
  const convWatchMin = (parkFactorForConvGate >= 1.10 && inningForConvGate >= 7)
    ? 0.015
    : HR_CONVERSION_WATCH_MIN;
  if (convProb !== null && convProb < convWatchMin) {
    console.log(`[HR_ALERT_CONV_GATE] ${input.playerName} game=${input.gameId} — convProb=${(convProb * 100).toFixed(1)}% below watch min ${(convWatchMin * 100).toFixed(1)}%. Suppressing.`);
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

  let hrTrendBoost = 0;
  const abSinceHR = input.abSinceLastHR;
  const seasonHRRate = input.seasonHRRate;
  if (abSinceHR != null && seasonHRRate != null && seasonHRRate > 0) {
    const expectedABperHR = 1 / seasonHRRate;
    if (abSinceHR >= expectedABperHR * 1.5) {
      hrTrendBoost += 1;
      positiveFactors.push(`HR overdue (${abSinceHR} AB since last, expected ~${Math.round(expectedABperHR)})`);
    }
  }

  const hrL7 = input.hrRateLast7;
  const hrL30 = input.hrRateLast30;
  if (hrL7 != null && hrL30 != null && hrL30 > 0 && hrL7 > hrL30 * 1.5) {
    hrTrendBoost += 0.5;
    positiveFactors.push(`HR rate trending up (L7=${(hrL7 * 100).toFixed(1)}% vs L30=${(hrL30 * 100).toFixed(1)}%)`);
  }

  if (input.handednessParkFactor != null && input.handednessParkFactor >= 1.10) {
    positiveFactors.push(`${input.batterHand ?? "?"}HB park HR factor ${input.handednessParkFactor.toFixed(2)}`);
  }

  // ── Goldmaster RESTORE Phase 4 — FAST PROMOTE on real danger ────────────
  // Additive shortcuts that can promote a row to Building (prepare) or
  // Attack (officialAlert) when in-game contact quality is unambiguously
  // dangerous, even if the existing score-based paths below would only
  // produce WATCH. These checks run BEFORE the legacy paths so a clearly
  // elite contact event isn't held back by the (stricter) thresholds in
  // PATH_A. They preserve all existing veto / cooldown / conv gates.
  // Detection-immutability is preserved: detectedInning is set to the same
  // `inning` the rest of this evaluator uses; downstream storage freezes
  // the first detected inning at CREATE time.
  const eliteBarrelHit = classified.some(
    c => c.exitVelocity >= 100 && c.distance >= 380
  );
  const dangerousSecondaryCount = factors.hardHits + factors.deepFlyouts;

  // ── User spec (2026-04-30) — minimum thresholds that form a "good HR
  // attempt": EV ≥ 95, bat speed ≥ 70 mph, xBA ≥ ~0.400. Three new
  // FAST_PROMOTE tiers run BEFORE the legacy barrel+secondary tiers so a
  // single elite contact, a barrel + meaningful xBA, or a barrel + decent
  // bat speed will reliably surface as an alert. Brady House
  // (106/25°/385ft), Spencer Horwitz (100.9/36°/397ft), and Juan Soto
  // (101.1/33°/375ft barrel) are the exemplar cases this targets.
  //
  // Per spec ("minimum thresholds = fire"), these tiers tolerate up to
  // ONE soft veto (e.g. same-side matchup, mild headwind, LA noise) so
  // a real elite contact event isn't suppressed by ambient context.
  // Hard vetoes still block earlier in this function. Confidence is
  // discounted by the suppression count via computeConfidence.
  const FAST_PROMOTE_SOFT_VETO_TOLERANCE = 1;
  const fastPromoteVetoOk = softVetoes.length <= FAST_PROMOTE_SOFT_VETO_TOLERANCE;
  const factorsMaxXBA = factors.maxXBA;
  const factorsBatSpeedMph = factors.batSpeedMph;

  // Tier 4-pre-A — Single elite HR-shaped contact alone → ATTACK.
  // The legacy BARREL_PLUS path required a barrel AND a hard-hit/deep-fly
  // secondary, which missed the Brady/Spencer cases (one elite ball, one
  // weak topped grounder). One ball with EV≥98, LA 22-36, dist≥360 IS the
  // minimum threshold per spec.
  if (
    factors.eliteHrCount >= 1 &&
    fastPromoteVetoOk &&
    (convProb === null || convProb >= HR_CONVERSION_OFFICIAL_MIN)
  ) {
    const conf = computeConfidence(hrBuildScore, factors, "FAST_PROMOTE_SINGLE_ELITE", softVetoes.length, convProb);
    console.log(`[HR_FAST_PROMOTE] ${input.playerName} game=${input.gameId} SINGLE_ELITE eliteHr=${factors.eliteHrCount} softVetoes=${softVetoes.length} → officialAlert`);
    return {
      level: "ALERT",
      triggerReason: `FAST_PROMOTE:single_elite_hr_contact`,
      signalState: "PEAK",
      decision: "BET_NOW",
      confidenceScore: conf,
      formattedReason: `Elite HR-shaped contact already in this game (conv ${convPct}). Promoting to Attack on minimum-threshold spec.`,
      detectedInning: inning,
      alertTier: "officialAlert",
      diagnostics: { ...baseDiagnostics, alertPath: "FAST_PROMOTE_SINGLE_ELITE", positiveFactors: [...positiveFactors, `${factors.eliteHrCount} elite HR contact`] },
    };
  }

  // Tier 4-pre-B — Barrel + meaningful xBA evidence → ATTACK.
  // Per spec, xBA in the .400+ range is a "good HR attempt" indicator.
  // This catches the Soto-style game where one PA was a barrel (101.1
  // mph BRL, xBA .550) and another was a near-barrel (100.4 mph, xBA
  // .750). The legacy BARREL_PLUS gate counted the second PA as
  // dangerous only if EV≥95 AND it was tracked as a hardHit; xBA gives
  // us a quality signal even when distance falls just short.
  if (
    factors.barrels >= 1 &&
    factorsMaxXBA != null && factorsMaxXBA >= 0.400 &&
    fastPromoteVetoOk &&
    (convProb === null || convProb >= HR_CONVERSION_OFFICIAL_MIN)
  ) {
    const conf = computeConfidence(hrBuildScore, factors, "FAST_PROMOTE_BARREL_XBA", softVetoes.length, convProb);
    console.log(`[HR_FAST_PROMOTE] ${input.playerName} game=${input.gameId} BARREL_XBA barrels=${factors.barrels} maxXBA=${factorsMaxXBA.toFixed(3)} softVetoes=${softVetoes.length} → officialAlert`);
    return {
      level: "ALERT",
      triggerReason: `FAST_PROMOTE:barrel_xba_${factorsMaxXBA.toFixed(2)}`,
      signalState: "PEAK",
      decision: "BET_NOW",
      confidenceScore: conf,
      formattedReason: `Barrel contact plus a high-xBA at-bat (max xBA ${factorsMaxXBA.toFixed(3)}, conv ${convPct}). Promoting to Attack on contact quality.`,
      detectedInning: inning,
      alertTier: "officialAlert",
      diagnostics: { ...baseDiagnostics, alertPath: "FAST_PROMOTE_BARREL_XBA", positiveFactors: [...positiveFactors, `barrel + xBA ${factorsMaxXBA.toFixed(3)}`] },
    };
  }

  // Tier 4-pre-C — Barrel + decent bat speed → Building.
  // Bat speed ≥ 70 mph is the user-spec minimum; combined with a real
  // barrel that's enough to elevate to Building (one tier below Attack)
  // even without a second damaging contact event.
  if (
    factors.barrels >= 1 &&
    factorsBatSpeedMph != null && factorsBatSpeedMph >= 70 &&
    fastPromoteVetoOk &&
    (convProb === null || convProb >= HR_CONVERSION_WATCH_MIN)
  ) {
    const conf = computeConfidence(hrBuildScore, factors, "FAST_PROMOTE_BARREL_BATSPEED", softVetoes.length, convProb);
    console.log(`[HR_FAST_PROMOTE] ${input.playerName} game=${input.gameId} BARREL_BATSPEED barrels=${factors.barrels} batSpeedMph=${factorsBatSpeedMph} softVetoes=${softVetoes.length} → prepare`);
    return {
      level: "ALERT",
      triggerReason: `FAST_PROMOTE:barrel_batspeed_${factorsBatSpeedMph}`,
      signalState: "BUILDING",
      decision: "PREPARE",
      confidenceScore: conf,
      formattedReason: `Barrel contact with capable bat speed (${factorsBatSpeedMph}mph, conv ${convPct}). Promoting to Building on minimum-threshold spec.`,
      detectedInning: inning,
      alertTier: "prepare",
      diagnostics: { ...baseDiagnostics, alertPath: "FAST_PROMOTE_BARREL_BATSPEED", positiveFactors: [...positiveFactors, `barrel + bat speed ${factorsBatSpeedMph}mph`] },
    };
  }

  // Tier 4-pre-D — EV ≥ 95 + xBA ≥ .400 (no barrel required) → ATTACK.
  // Direct encoding of the user spec ("EV ≥ 95 is good, xBA in .400+ is
  // good — these form minimum thresholds for a good HR attempt").
  // Catches scorched line drives and high-xBA contact that miss the
  // barrel definition by launch angle alone — e.g. a 100 mph ball at
  // 12° (.700 xBA, line drive) or 96 mph at 40° (.450 xBA, deep fly).
  // The barrel-gated tiers above (BARREL_XBA, BARREL_BATSPEED) won't
  // fire on these because there's no formal barrel; this tier closes
  // that gap.
  const factorsMaxEV = factors.maxEV;
  if (
    factorsMaxEV != null && factorsMaxEV >= 95 &&
    factorsMaxXBA != null && factorsMaxXBA >= 0.400 &&
    fastPromoteVetoOk &&
    (convProb === null || convProb >= HR_CONVERSION_OFFICIAL_MIN)
  ) {
    const conf = computeConfidence(hrBuildScore, factors, "FAST_PROMOTE_EV_XBA", softVetoes.length, convProb);
    console.log(`[HR_FAST_PROMOTE] ${input.playerName} game=${input.gameId} EV_XBA maxEV=${factorsMaxEV} maxXBA=${factorsMaxXBA.toFixed(3)} softVetoes=${softVetoes.length} → officialAlert`);
    return {
      level: "ALERT",
      triggerReason: `FAST_PROMOTE:ev_xba_${factorsMaxEV}_${factorsMaxXBA.toFixed(2)}`,
      signalState: "PEAK",
      decision: "BET_NOW",
      confidenceScore: conf,
      formattedReason: `Hard contact (${factorsMaxEV}mph) plus high-xBA at-bat (max xBA ${factorsMaxXBA.toFixed(3)}, conv ${convPct}). Promoting to Attack on minimum-threshold spec.`,
      detectedInning: inning,
      alertTier: "officialAlert",
      diagnostics: { ...baseDiagnostics, alertPath: "FAST_PROMOTE_EV_XBA", positiveFactors: [...positiveFactors, `EV ${factorsMaxEV}mph + xBA ${factorsMaxXBA.toFixed(3)}`] },
    };
  }

  // Tier 4a — Elite barrel (EV≥105, dist≥400) + collapsing pitcher → ATTACK.
  // Spec is unambiguous: this is the strongest in-game contact signal we
  // recognize and it must always emit officialAlert (Attack stage). The
  // conversion gate is the OFFICIAL min — we do not downgrade this tier
  // to Building on borderline conv probabilities.
  if (
    factors.barrels >= 1 &&
    eliteBarrelHit &&
    input.isPitcherCollapsing === true &&
    softVetoes.length === 0 &&
    (convProb === null || convProb >= HR_CONVERSION_OFFICIAL_MIN)
  ) {
    const conf = computeConfidence(hrBuildScore, factors, "FAST_PROMOTE_ELITE", softVetoes.length, convProb);
    console.log(`[HR_FAST_PROMOTE] ${input.playerName} game=${input.gameId} ELITE_BARREL_COLLAPSE barrels=${factors.barrels} eliteHit=true collapsing=true → officialAlert`);
    return {
      level: "ALERT",
      triggerReason: `FAST_PROMOTE:eliteBarrel_collapsing`,
      signalState: "PEAK",
      decision: "BET_NOW",
      confidenceScore: conf,
      formattedReason: `Elite barrel contact against a fading pitcher (conv ${convPct}). Punching through to Attack Now.`,
      detectedInning: inning,
      alertTier: "officialAlert",
      diagnostics: { ...baseDiagnostics, alertPath: "FAST_PROMOTE_ELITE", positiveFactors: [...positiveFactors, "elite barrel + collapsing pitcher"] },
    };
  }

  // Tier 4b — Barrel + ANY second dangerous contact → ATTACK.
  // Per spec this is officialAlert: a real barrel plus any other hard-hit /
  // deep-fly event is a two-event danger pattern that warrants Attack.
  if (
    factors.barrels >= 1 &&
    dangerousSecondaryCount >= 1 &&
    softVetoes.length === 0 &&
    (convProb === null || convProb >= HR_CONVERSION_OFFICIAL_MIN)
  ) {
    const conf = computeConfidence(hrBuildScore, factors, "FAST_PROMOTE_BARREL_PLUS", softVetoes.length, convProb);
    console.log(`[HR_FAST_PROMOTE] ${input.playerName} game=${input.gameId} BARREL_PLUS barrels=${factors.barrels} secondary=${dangerousSecondaryCount} → officialAlert`);
    return {
      level: "ALERT",
      triggerReason: `FAST_PROMOTE:barrel_plus_${dangerousSecondaryCount}danger`,
      signalState: "PEAK",
      decision: "BET_NOW",
      confidenceScore: conf,
      formattedReason: `Barrel plus a second dangerous contact (conv ${convPct}). Promoting to Attack on contact pattern.`,
      detectedInning: inning,
      alertTier: "officialAlert",
      diagnostics: { ...baseDiagnostics, alertPath: "FAST_PROMOTE_BARREL_PLUS", positiveFactors: [...positiveFactors, `barrel + ${dangerousSecondaryCount} dangerous contact`] },
    };
  }

  // Phase 3 — Tier 4c-elite. Pure additive ease for `elite_power` archetypes:
  // a single barrel alone is enough to reach `prepare`, even without
  // pitcher/env favorability. Never downgrades; if this branch doesn't fire,
  // the legacy tier 4c below runs identically.
  if (
    input.batterArchetype === "elite_power" &&
    factors.barrels >= 1 &&
    softVetoes.length === 0 &&
    (convProb === null || convProb >= HR_CONVERSION_WATCH_MIN)
  ) {
    const conf = computeConfidence(hrBuildScore, factors, "FAST_PROMOTE_BARREL_ELITE_POWER", softVetoes.length, convProb);
    console.log(`[HR_FAST_PROMOTE] ${input.playerName} game=${input.gameId} BARREL_ELITE_POWER barrels=${factors.barrels} archetype=elite_power → prepare`);
    return {
      level: "ALERT",
      triggerReason: `FAST_PROMOTE:barrel_elite_power`,
      signalState: "BUILDING",
      decision: "PREPARE",
      confidenceScore: conf,
      formattedReason: `Elite-power bat with barrel contact (conv ${convPct}). Promoting to Building on power profile.`,
      detectedInning: inning,
      alertTier: "prepare",
      diagnostics: { ...baseDiagnostics, alertPath: "FAST_PROMOTE_BARREL_ELITE_POWER", positiveFactors: [...positiveFactors, "barrel + elite_power archetype"] },
    };
  }

  // Tier 4c — Single barrel + favorable in-game context → Building.
  if (
    factors.barrels >= 1 &&
    (pitcherFavorable || envFavorable) &&
    softVetoes.length === 0 &&
    (convProb === null || convProb >= HR_CONVERSION_WATCH_MIN)
  ) {
    const conf = computeConfidence(hrBuildScore, factors, "FAST_PROMOTE_BARREL_CTX", softVetoes.length, convProb);
    console.log(`[HR_FAST_PROMOTE] ${input.playerName} game=${input.gameId} BARREL_CTX barrels=${factors.barrels} pitcherFav=${pitcherFavorable} envFav=${envFavorable} → prepare`);
    return {
      level: "ALERT",
      triggerReason: `FAST_PROMOTE:barrel_ctx`,
      signalState: "BUILDING",
      decision: "PREPARE",
      confidenceScore: conf,
      formattedReason: `Barrel contact with favorable matchup conditions (conv ${convPct}). Promoting to Building.`,
      detectedInning: inning,
      alertTier: "prepare",
      diagnostics: { ...baseDiagnostics, alertPath: "FAST_PROMOTE_BARREL_CTX", positiveFactors: [...positiveFactors, "barrel + favorable context"] },
    };
  }

  // Tier 4d — Two hard-hit balls (≥95 mph counted server-side) → Building.
  if (
    factors.hardHits >= 2 &&
    softVetoes.length === 0 &&
    (convProb === null || convProb >= HR_CONVERSION_WATCH_MIN)
  ) {
    const conf = computeConfidence(hrBuildScore, factors, "FAST_PROMOTE_2HH", softVetoes.length, convProb);
    console.log(`[HR_FAST_PROMOTE] ${input.playerName} game=${input.gameId} TWO_HARD_HIT hardHits=${factors.hardHits} → prepare`);
    return {
      level: "ALERT",
      triggerReason: `FAST_PROMOTE:2hardhit`,
      signalState: "BUILDING",
      decision: "PREPARE",
      confidenceScore: conf,
      formattedReason: `Two hard-hit balls in this game (conv ${convPct}). Promoting to Building on repeat contact.`,
      detectedInning: inning,
      alertTier: "prepare",
      diagnostics: { ...baseDiagnostics, alertPath: "FAST_PROMOTE_2HH", positiveFactors: [...positiveFactors, `${factors.hardHits} hard-hit balls`] },
    };
  }

  // Fix B — conviction-bridge. A high-conviction, high-score profile with at
  // least one HR-shaped contact can reach the HR Max Window even without a
  // textbook barrel or a second HR-shaped ball: convProb at the official floor
  // (0.12), a strong build score, and HR-shaped contact. Closes the "high
  // conviction + high score + no barrel ⇒ permanently stuck at building" gap.
  // Additive — no-op unless every gate clears; Phase 1.5 caps still bind the
  // per-PA rate upstream. NOTE: the 8.5 build-score floor is intentionally
  // conservative (never over-fires a counted cash) and should be re-validated /
  // tuned against live fixtures once replayable game data is available.
  if (
    convProb !== null && convProb >= HR_CONVERSION_OFFICIAL_MIN &&
    hrBuildScore >= 8.5 &&
    totalHrShaped >= 1 &&
    softVetoes.length === 0
  ) {
    const conf = computeConfidence(hrBuildScore, factors, "FAST_PROMOTE_CONVICTION_BRIDGE", softVetoes.length, convProb);
    console.log(`[HR_FAST_PROMOTE] ${input.playerName} game=${input.gameId} CONVICTION_BRIDGE score=${hrBuildScore.toFixed(1)} conv=${convPct} hrShaped=${totalHrShaped} → officialAlert`);
    return {
      level: "ALERT",
      triggerReason: `FAST_PROMOTE:conviction_bridge_score${hrBuildScore.toFixed(1)}`,
      signalState: "PEAK",
      decision: "BET_NOW",
      confidenceScore: conf,
      formattedReason: `High-conviction power build (score ${hrBuildScore.toFixed(1)}/10, conv ${convPct}) with HR-shaped contact. Promoting to HR Max Window on conviction.`,
      detectedInning: inning,
      alertTier: "officialAlert",
      diagnostics: { ...baseDiagnostics, alertPath: "FAST_PROMOTE_CONVICTION_BRIDGE", positiveFactors: [...positiveFactors, `conviction bridge: score ${hrBuildScore.toFixed(1)}, ${totalHrShaped} HR-shaped`] },
    };
  }

  if (
    totalHrShaped >= 2 &&
    (qualifiedEVMean ?? 0) >= 95 &&
    (maxDistance ?? 0) >= 350 &&
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
    (qualifiedEVMean ?? 0) >= 92 &&
    hrBuildScore >= 3.5 &&
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
    hrBuildScore >= 3.0 &&
    (remainingPA === null || remainingPA >= 1.0) &&
    (convProb === null || convProb >= HR_CONVERSION_WATCH_MIN)
  ) {
    positiveFactors.push(`${totalHrShaped} HR-shaped events, score=${hrBuildScore}`);
    positiveFactors.push(`conversion: ${convPct}`);

    const leiResult = computeLeiBoost(input);
    if (leiResult.escalate && hrBuildScore >= 2.8 && (convProb === null || convProb >= HR_CONVERSION_ALERT_MIN)) {
      positiveFactors.push(`LEI escalation: nearHR=${input.leiNearHrScore?.toFixed(2)}, momentum=${input.leiMomentumScore?.toFixed(2)}`);
      if (input.leiTags?.length) positiveFactors.push(`LEI tags: ${input.leiTags.join(", ")}`);
      const conf = computeConfidence(hrBuildScore + leiResult.scoreBoost, factors, "PATH_B", softVetoes.length, convProb);

      return {
        level: "ALERT",
        triggerReason: `LEI_ESCALATION:hrShaped${totalHrShaped}_score${hrBuildScore}_lei`,
        signalState: "BUILDING",
        decision: "PREPARE",
        confidenceScore: conf,
        formattedReason: `HR-shaped contact with live event reinforcement (conv ${convPct}). Contact trend + pitcher deterioration elevating signal.`,
        detectedInning: inning,
        alertTier: "prepare",
        diagnostics: { ...baseDiagnostics, alertPath: "LEI_ESCALATION", positiveFactors },
      };
    }

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

  const powerContactCount = classified.filter(c => c.contactClass === "powerContact").length;
  const hasStrongProfile = (input.barrelRate != null && input.barrelRate >= 0.06) ||
    (input.xSLG != null && input.xSLG >= 0.420) ||
    (input.hardHitRate != null && input.hardHitRate >= 0.38);
  const isHotTrend = (input.hrRateLast7 != null && input.hrRateLast30 != null && input.hrRateLast30 > 0 && input.hrRateLast7 > input.hrRateLast30 * 1.3) ||
    (input.seasonHRRate != null && input.seasonHRRate >= 0.040);

  const hasQualityPowerContact = classified.some(c =>
    c.contactClass === "powerContact" && c.exitVelocity >= 92 && c.distance >= 320
  );

  if (
    totalHrShaped === 0 &&
    (powerContactCount >= 2 || (powerContactCount >= 1 && hasQualityPowerContact)) &&
    (hasStrongProfile || isHotTrend) &&
    (pitcherFavorable || envFavorable) &&
    hrBuildScore >= 2.8 &&
    (remainingPA === null || remainingPA >= 1.0) &&
    (convProb === null || convProb >= HR_CONVERSION_WATCH_MIN)
  ) {
    positiveFactors.push(`${powerContactCount} power contact events`);
    if (hasStrongProfile) {
      const profileParts: string[] = [];
      if (input.barrelRate != null) profileParts.push(`barrel=${(input.barrelRate * 100).toFixed(1)}%`);
      if (input.xSLG != null) profileParts.push(`xSLG=${input.xSLG.toFixed(3)}`);
      if (input.hardHitRate != null) profileParts.push(`hardHit=${(input.hardHitRate * 100).toFixed(1)}%`);
      positiveFactors.push(`strong profile: ${profileParts.join(", ")}`);
    }
    if (isHotTrend) positiveFactors.push("hot HR trend");
    positiveFactors.push(`conversion: ${convPct}`);
    if (pitcherFavorable) positiveFactors.push(`pitcher: ${pitcherFatigueState}`);
    if (envFavorable) positiveFactors.push(`env: ${environmentContext}`);

    const isAlert = hasStrongProfile && isHotTrend && hasModerateContext && softVetoes.length === 0 && hrBuildScore >= 3.5 && (convProb === null || convProb >= HR_CONVERSION_ALERT_MIN);
    const conf = computeConfidence(hrBuildScore, factors, "PATH_D", softVetoes.length, convProb);

    console.log(`[HR_ALERT_PATH_D] ${input.playerName} game=${input.gameId} — profile-based detection: power=${powerContactCount} strongProfile=${hasStrongProfile} hotTrend=${isHotTrend} score=${hrBuildScore} conv=${convPct} alert=${isAlert}`);

    if (isAlert) {
      return {
        level: "ALERT",
        triggerReason: `PATH_D:profile_power${powerContactCount}_score${hrBuildScore}`,
        signalState: "BUILDING",
        decision: "PREPARE",
        confidenceScore: conf,
        formattedReason: `Power profile + live contact (conv ${convPct}). Strong hitter profile with favorable game conditions.`,
        detectedInning: inning,
        alertTier: "prepare",
        diagnostics: { ...baseDiagnostics, alertPath: "PATH_D", positiveFactors },
      };
    }

    return {
      level: "WATCH",
      triggerReason: `watch:profile_power${powerContactCount}_score${hrBuildScore}`,
      signalState: "FORMATION",
      decision: "MONITOR",
      confidenceScore: conf,
      formattedReason: `Power hitter profile with live contact detected (conv ${convPct}). Monitoring for HR-shaped escalation.`,
      detectedInning: inning,
      alertTier: "watch",
      diagnostics: { ...baseDiagnostics, alertPath: "PATH_D", positiveFactors },
    };
  }

  const powerIndicators = factors.barrels + factors.hardHits + factors.deepFlyouts;
  if (
    totalHrShaped === 0 &&
    powerIndicators >= 2 &&
    hrBuildScore >= 3.0 &&
    (remainingPA === null || remainingPA >= 1.0)
  ) {
    positiveFactors.push(`${powerIndicators} power indicators (${factors.barrels}B/${factors.hardHits}HH/${factors.deepFlyouts}DF)`);
    positiveFactors.push(`score=${hrBuildScore}`);
    if (convProb !== null) positiveFactors.push(`conversion: ${convPct}`);
    if (pitcherFavorable) positiveFactors.push(`pitcher: ${pitcherFatigueState}`);
    if (envFavorable) positiveFactors.push(`env: ${environmentContext}`);

    console.log(`[HR_ALERT_POWER_WATCH] ${input.playerName} game=${input.gameId} — power indicators (barrels=${factors.barrels} hardHits=${factors.hardHits} deepFly=${factors.deepFlyouts}) score=${hrBuildScore} conv=${convPct}. Promoting to WATCH.`);

    return {
      level: "WATCH",
      triggerReason: `watch:power${powerIndicators}_score${hrBuildScore}`,
      signalState: "FORMATION",
      decision: "MONITOR",
      confidenceScore: computeConfidence(hrBuildScore, factors, null, softVetoes.length, convProb),
      formattedReason: `HR-shaped contact detected. Monitoring for escalation — need repeat confirmation or stronger context.`,
      detectedInning: inning,
      alertTier: "watch",
      diagnostics: { ...baseDiagnostics, alertPath: "WATCH_POWER", positiveFactors },
    };
  }

  // ── PATH_PRE_HR_DANGER ────────────────────────────────────────────────────
  // Pre-HR damage signal: surfaces hitters who haven't produced classic
  // HR-shaped contact yet but show the precursor pattern — elite bat speed,
  // strong hitter power profile, and warning-class contact (lifted air balls,
  // bat-speed warning swings). Targets cases like Caminero where a HR is
  // imminent but the radar would otherwise stay silent until a 96+ EV /
  // 340+ ft contact lands.
  //
  // Strict guardrails: WATCH (or PREPARE for very strong cases) only — NEVER
  // PEAK / officialAlert. Requires totalHrShaped=0 (so it never collides
  // with classic paths), no soft vetoes, viable PA, and a power-hitter
  // profile to keep noise low. All upstream gates still apply.
  const preHrDangerEnabled = (process.env.HR_PRE_HR_DANGER_PATH_ENABLED ?? "true").toLowerCase() !== "false";
  const f: any = factors;
  const preHrDangerScore = input.preHrDangerScore ?? 0;
  const dangerFlags = input.dangerFlags ?? [];
  const hpProfile = (f.hitterPowerProfileScore ?? 0) as number;
  const bsZ = (f.batSpeedZ ?? 0) as number;
  const bsPower = (f.batSpeedPowerScore ?? 0) as number;
  const airDanger = (f.airDangerScore ?? 0) as number;
  const warningCount = (f.warningContactCount ?? 0) as number;
  const popupCount = (f.deadPopupCount ?? 0) as number;

  const hasWarningSignal = warningCount >= 1 || bsZ >= 1.28 || airDanger >= 0.5;
  const hasStrongPreHrProfile = hpProfile >= 0.55;

  if (
    preHrDangerEnabled &&
    hrShapedCount === 0 &&
    preHrDangerScore >= 3.5 &&
    hasStrongPreHrProfile &&
    hasWarningSignal &&
    popupCount <= warningCount &&
    softVetoes.length === 0 &&
    (remainingPA === null || remainingPA >= 1.0) &&
    (convProb === null || convProb >= HR_CONVERSION_WATCH_MIN)
  ) {
    positiveFactors.push(`pre-HR danger ${preHrDangerScore.toFixed(2)} (profile=${hpProfile.toFixed(2)}, bsZ=${bsZ.toFixed(2)}, airDanger=${airDanger.toFixed(2)})`);
    if (warningCount > 0) positiveFactors.push(`${warningCount} warning contact${warningCount === 1 ? "" : "s"} (air=${f.airBallWarningCount ?? 0}, bs=${f.batSpeedWarningCount ?? 0})`);
    if (dangerFlags.length > 0) positiveFactors.push(`flags: ${dangerFlags.slice(0, 4).join(", ")}`);
    positiveFactors.push(`conversion: ${convPct}`);
    if (pitcherFavorable) positiveFactors.push(`pitcher: ${pitcherFatigueState}`);
    if (envFavorable) positiveFactors.push(`env: ${environmentContext}`);

    // Promote to PREPARE only when the danger signal is very strong AND
    // both context and conversion confirm. Otherwise WATCH-only. Never PEAK.
    const isPrepare =
      preHrDangerScore >= 5.0 &&
      hpProfile >= 0.7 &&
      bsZ >= 1.5 &&
      hasModerateContext &&
      (convProb === null || convProb >= HR_CONVERSION_ALERT_MIN);

    const rawConf = computeConfidence(hrBuildScore, factors, "PATH_PRE_HR_DANGER", softVetoes.length, convProb);
    // Cap confidence — pre-HR danger is precursor-only, no realized damage shape yet.
    const cappedConf = Math.min(isPrepare ? 7.5 : 6.5, rawConf);

    console.log(`[HR_ALERT_PATH_PRE_HR_DANGER] ${input.playerName} game=${input.gameId} preHrDanger=${preHrDangerScore.toFixed(2)} profile=${hpProfile.toFixed(2)} bsZ=${bsZ.toFixed(2)} airDanger=${airDanger.toFixed(2)} warnings=${warningCount} popups=${popupCount} score=${hrBuildScore} conv=${convPct} -> ${isPrepare ? "PREPARE" : "WATCH"}`);

    return {
      level: isPrepare ? "ALERT" : "WATCH",
      triggerReason: `PATH_PRE_HR_DANGER:danger${preHrDangerScore.toFixed(2)}_profile${hpProfile.toFixed(2)}_bsZ${bsZ.toFixed(2)}`,
      signalState: isPrepare ? "BUILDING" : "FORMATION",
      decision: isPrepare ? "PREPARE" : "MONITOR",
      confidenceScore: cappedConf,
      formattedReason: `Pre-HR danger pattern detected (conv ${convPct}). Elite bat speed + power profile + warning contact precede classic HR shape — ${isPrepare ? "preparing" : "watching"} for escalation.`,
      detectedInning: inning,
      alertTier: isPrepare ? "prepare" : "watch",
      diagnostics: { ...baseDiagnostics, alertPath: "PATH_PRE_HR_DANGER", positiveFactors },
    };
  }

  // ── PATH_POPUP_PARK_LATE ─────────────────────────────────────────────────
  // Popup-to-HR precursor in hitter-friendly parks during late innings.
  // Catches slap-hitters and contact batters who pop up repeatedly (getting
  // under pitches), then elevate one in a short park (IKF pattern: 2 popups
  // at 63° and 83°, then a 98.4 mph / 42° HR in B8 of a hitter-friendly park).
  // Deliberately does NOT require a power profile — the park does the work.
  // WATCH-only, low confidence ceiling to avoid false positives.
  if (
    popupCount >= 2 &&
    hrShapedCount === 0 &&
    (input.parkFactor ?? 1.0) >= 1.10 &&
    (input.inning ?? 1) >= 7 &&
    softVetoes.length === 0 &&
    (remainingPA === null || remainingPA >= 1.0)
  ) {
    const rawConf = computeConfidence(hrBuildScore, factors, "PATH_POPUP_PARK_LATE", softVetoes.length, convProb);
    const cappedConf = Math.min(4.0, rawConf);
    console.log(`[HR_ALERT_PATH_POPUP_PARK_LATE] ${input.playerName} game=${input.gameId} popups=${popupCount} park=${(input.parkFactor ?? 1.0).toFixed(2)} inning=${input.inning ?? 1} score=${hrBuildScore} conv=${convPct}`);
    return {
      level: "WATCH",
      triggerReason: `PATH_POPUP_PARK_LATE:popups${popupCount}_park${(input.parkFactor ?? 1.0).toFixed(2)}_inn${input.inning ?? 1}`,
      signalState: "FORMATION",
      decision: "MONITOR",
      confidenceScore: cappedConf,
      formattedReason: `${popupCount} popups in hitter-friendly park, late innings — elevation pattern building (conv ${convPct}).`,
      detectedInning: inning,
      alertTier: "watch",
      diagnostics: { ...baseDiagnostics, alertPath: "PATH_POPUP_PARK_LATE", positiveFactors: [...positiveFactors, `${popupCount} dead popups`, `park ${(input.parkFactor ?? 1.0).toFixed(2)}`] },
    };
  }

  // ── PATH_LATE_INNING_EV_WATCH ────────────────────────────────────────────
  // Hard-hit floor for power hitters facing fatigued pitchers in late innings.
  // A batter who hammered a non-HR-shaped contact early (e.g. a 95.5 mph
  // groundball at -11° like Bazzana) should remain on watch when the pitcher
  // is now deep in the count in T7+. The early hard hit shows bat-speed
  // capability; pitcher fatigue shifts the expected pitch quality.
  // WATCH-only, moderate confidence ceiling (5.0) — no HR shape seen yet.
  if (
    totalHrShaped === 0 &&
    factors.hardHits >= 1 &&
    factors.maxEV != null && factors.maxEV >= 95 &&
    (input.inning ?? 1) >= 7 &&
    pitcherFavorable &&
    softVetoes.length === 0 &&
    (remainingPA === null || remainingPA >= 1.0)
  ) {
    const rawConf = computeConfidence(hrBuildScore, factors, "PATH_LATE_INNING_EV_WATCH", softVetoes.length, convProb);
    const cappedConf = Math.min(5.0, rawConf);
    console.log(`[HR_ALERT_PATH_LATE_INNING_EV] ${input.playerName} game=${input.gameId} hardHits=${factors.hardHits} maxEV=${factors.maxEV} inning=${input.inning ?? 1} pitcherFav=${pitcherFavorable} score=${hrBuildScore} conv=${convPct}`);
    return {
      level: "WATCH",
      triggerReason: `PATH_LATE_INNING_EV:hardHit${factors.hardHits}_maxEV${factors.maxEV}_inn${input.inning ?? 1}`,
      signalState: "FORMATION",
      decision: "MONITOR",
      confidenceScore: cappedConf,
      formattedReason: `Hard-hit contact earlier this game (max EV ${factors.maxEV} mph) with pitcher now fatigued in T${input.inning ?? 1} — watching for late-inning power event (conv ${convPct}).`,
      detectedInning: inning,
      alertTier: "watch",
      diagnostics: { ...baseDiagnostics, alertPath: "PATH_LATE_INNING_EV_WATCH", positiveFactors: [...positiveFactors, `${factors.hardHits} hard-hit ball(s)`, `maxEV ${factors.maxEV}`, `pitcher: ${pitcherFatigueState}`] },
    };
  }

  // PATH_E (CONVICTION FALLBACK) — high-conviction safety net.
  //
  // Was previously WATCH-tier ONLY, which capped
  // 25%+ conviction batters (Moisés Ballesteros, Shea Langeliers,
  // Carter Jensen, etc.) at the Track section even though the dynamic
  // engine had already promoted them to BET_NOW. Now uses a graduated
  // tier escalator that reflects the engine's true conviction:
  //
  //   conv ≥ 0.25 + score ≥ 7.0 + strong context → PEAK   (alertTier=peak)
  //   conv ≥ 0.20 + score ≥ 6.0 + moderate ctx   → PREPARE (alertTier=prepare)
  //   conv ≥ 0.15 + score ≥ 4.5 (default)        → WATCH   (alertTier=watch)
  //
  // All upstream gates (cooldown, hard veto, conv-low) still apply.
  // Behind a kill-switch env var so it can be disabled instantly if it
  // produces noise.
  const convictionPathEnabled = (process.env.HR_CONVICTION_PATH_ENABLED ?? "true").toLowerCase() !== "false";
  const HR_CONVICTION_CONV_MIN = 0.15;
  const HR_CONVICTION_SCORE_MIN = 4.5;
  const HR_CONVICTION_PREPARE_CONV = 0.20;
  const HR_CONVICTION_PREPARE_SCORE = 6.0;
  const HR_CONVICTION_PEAK_CONV = 0.25;
  const HR_CONVICTION_PEAK_SCORE = 7.0;
  const hasAnyPowerSignal = powerIndicators >= 1 || powerContactCount >= 1;

  if (
    convictionPathEnabled &&
    totalHrShaped === 0 &&
    convProb !== null &&
    convProb >= HR_CONVICTION_CONV_MIN &&
    hrBuildScore >= HR_CONVICTION_SCORE_MIN &&
    hasAnyPowerSignal &&
    softVetoes.length === 0 &&
    (remainingPA === null || remainingPA >= 1.0)
  ) {
    positiveFactors.push(`high model conviction (score=${hrBuildScore}, conv=${convPct})`);
    positiveFactors.push(`power signal: ${powerIndicators} indicator${powerIndicators === 1 ? "" : "s"} / ${powerContactCount} power contact${powerContactCount === 1 ? "" : "s"}`);
    if (pitcherFavorable) positiveFactors.push(`pitcher: ${pitcherFatigueState}`);
    if (envFavorable) positiveFactors.push(`env: ${environmentContext}`);

    // Tier escalator — only escalates above WATCH when both
    // conviction AND score clear the higher bar AND favorable context
    // confirms. Otherwise the original WATCH-tier behavior is preserved.
    // PEAK additionally requires at least one *power contact* (not just an
    // indicator) and favorable pitcher OR env per task spec (step 2).
    const isPeak =
      convProb >= HR_CONVICTION_PEAK_CONV &&
      hrBuildScore >= HR_CONVICTION_PEAK_SCORE &&
      powerContactCount >= 1 &&
      (pitcherFavorable || envFavorable);
    const isPrepare =
      !isPeak &&
      convProb >= HR_CONVICTION_PREPARE_CONV &&
      hrBuildScore >= HR_CONVICTION_PREPARE_SCORE;

    const rawConf = computeConfidence(hrBuildScore, factors, null, softVetoes.length, convProb);
    // Cap confidence per tier — contact evidence is thinner than other paths.
    const cappedConf = isPeak
      ? Math.min(8.5, rawConf)
      : isPrepare
      ? Math.min(7.5, rawConf)
      : Math.min(7, rawConf);

    const tier: "peak" | "prepare" | "watch" = isPeak ? "peak" : isPrepare ? "prepare" : "watch";
    const tierUpper = tier.toUpperCase();
    console.log(`[HR_ALERT_PATH_E_CONVICTION] ${input.playerName} game=${input.gameId} — ${tierUpper} (score=${hrBuildScore} conv=${convPct} powerInd=${powerIndicators} powerContact=${powerContactCount}).`);

    if (isPeak) {
      return {
        level: "ALERT",
        triggerReason: `peak:conviction_score${hrBuildScore}_conv${(convProb * 100).toFixed(0)}`,
        signalState: "PEAK",
        decision: "BET_NOW",
        confidenceScore: cappedConf,
        formattedReason: `Highest HR conversion likelihood (${convPct}) with build score ${hrBuildScore}. Engine has high conviction — fire signal.`,
        detectedInning: inning,
        alertTier: "officialAlert",
        diagnostics: { ...baseDiagnostics, alertPath: "PATH_E_CONVICTION", positiveFactors },
      };
    }
    if (isPrepare) {
      return {
        level: "ALERT",
        triggerReason: `prepare:conviction_score${hrBuildScore}_conv${(convProb * 100).toFixed(0)}`,
        signalState: "BUILDING",
        decision: "PREPARE",
        confidenceScore: cappedConf,
        formattedReason: `High HR conversion likelihood (${convPct}) with build score ${hrBuildScore}. Conditions building — prepare for escalation.`,
        detectedInning: inning,
        alertTier: "prepare",
        diagnostics: { ...baseDiagnostics, alertPath: "PATH_E_CONVICTION", positiveFactors },
      };
    }
    return {
      level: "WATCH",
      triggerReason: `watch:conviction_score${hrBuildScore}_conv${(convProb * 100).toFixed(0)}`,
      signalState: "FORMATION",
      decision: "MONITOR",
      confidenceScore: cappedConf,
      formattedReason: `High HR conversion likelihood (${convPct}) with build score ${hrBuildScore}. Watching for contact-event confirmation.`,
      detectedInning: inning,
      alertTier: "watch",
      diagnostics: { ...baseDiagnostics, alertPath: "PATH_E_CONVICTION", positiveFactors },
    };
  }

  // ── PATH_F_BLOCKED_BRIDGE ────────────────────────────────────────────────
  // Was previously a silent BLOCKED log returning nullResult, which left
  // moderate-conviction batters (e.g. Mike Trout conv=27.1% score=4.4,
  // Bobby Witt Jr conv=17.5% score=3.24, Teoscar Hernández conv=26.3%
  // score=3.43) entirely invisible on the radar. Surfaces them as a
  // WATCH-tier signal so the user can see the pattern even when
  // build-score hasn't crossed PATH_E's score floor.
  //
  // Strict guardrails: WATCH-tier ONLY (never PREPARE/BET_NOW). Per task
  // spec (step 3) the only required floors are: powerIndicators >= 1 AND
  // calibrated conv >= HR_CONVERSION_WATCH_MIN. No softVetoes / remainingPA
  // gate here — those would re-introduce silent blocks contrary to spec.
  // The only condition for silence on this branch is conv below watch min.
  // Behind a kill-switch env var.
  const blockedBridgeEnabled = (process.env.HR_BLOCKED_BRIDGE_ENABLED ?? "true").toLowerCase() !== "false";

  if (
    blockedBridgeEnabled &&
    totalHrShaped === 0 &&
    powerIndicators >= 1 &&
    convProb !== null &&
    convProb >= HR_CONVERSION_WATCH_MIN
  ) {
    positiveFactors.push(`bridged from blocked: conv=${convPct} score=${hrBuildScore}`);
    positiveFactors.push(`power indicator: ${powerIndicators} (barrels=${factors.barrels}/hardHits=${factors.hardHits}/deepFly=${factors.deepFlyouts})`);
    if (pitcherFavorable) positiveFactors.push(`pitcher: ${pitcherFatigueState}`);
    if (envFavorable) positiveFactors.push(`env: ${environmentContext}`);

    const rawConf = computeConfidence(hrBuildScore, factors, null, softVetoes.length, convProb);
    const cappedConf = Math.min(6, rawConf);

    console.log(`[HR_ALERT_PATH_F_BLOCKED_BRIDGE] ${input.playerName} game=${input.gameId} — surfacing as WATCH (score=${hrBuildScore} conv=${convPct} powerInd=${powerIndicators}).`);

    return {
      level: "WATCH",
      triggerReason: `watch:bridged_score${hrBuildScore}_conv${(convProb * 100).toFixed(0)}`,
      signalState: "FORMATION",
      decision: "MONITOR",
      confidenceScore: cappedConf,
      formattedReason: `Power profile detected (${convPct} HR likelihood, build score ${hrBuildScore}). Below alert threshold — tracking for confirmation.`,
      detectedInning: inning,
      alertTier: "watch",
      diagnostics: { ...baseDiagnostics, alertPath: "PATH_F_BLOCKED_BRIDGE", positiveFactors },
    };
  }

  if (
    totalHrShaped === 0 &&
    powerIndicators >= 1 &&
    hrBuildScore >= 2.5
  ) {
    console.log(`[HR_ALERT_BLOCKED] ${input.playerName} game=${input.gameId} — power indicators (barrels=${factors.barrels} hardHits=${factors.hardHits} deepFly=${factors.deepFlyouts}) but insufficient for watch. Score=${hrBuildScore} conv=${convPct}.`);
  }

  return nullResult;
}

// ─── Phase 2 — EV gate against the batter_home_runs market ─────────────────
// The HR Max Window (officialAlert) is the only tier graded to the record, so
// it should only fire when the model's game P(HR) beats the market price. This
// is a thin post-processing wrapper around the core evaluator: it can DEMOTE
// an otherwise-actionable signal to "prepare" (Building) when the edge is
// negative/insufficient, but never promotes. Additive + no-op when odds are
// absent so partial coverage never suppresses signals (Hard-Rule §7a #2).

/** Model game P(HR) must beat the de-vigged market-implied prob by this much
 * (relative) to hold the actionable HR Max Window tier. */
export const HR_EV_EDGE_MARGIN = 0.10;

/** American odds → implied probability (0–1). Null for missing/garbage. Pure. */
export function americanToImpliedProb(odds: number | null | undefined): number | null {
  if (odds == null || !Number.isFinite(odds)) return null;
  if (odds < 0) return Math.abs(odds) / (Math.abs(odds) + 100);
  if (odds > 0) return 100 / (odds + 100);
  return null;
}

/** De-vigged market-implied P(HR) from the over (and optional under) price.
 * Two-sided removes the bookmaker hold; one-sided falls back to raw over
 * implied (which slightly overstates HR prob → a stricter, conservative gate).
 * Pure; null when no usable over price. */
export function deviggedMarketHrProb(
  overOdds: number | null | undefined,
  underOdds: number | null | undefined,
): number | null {
  const over = americanToImpliedProb(overOdds);
  if (over == null) return null;
  const under = americanToImpliedProb(underOdds);
  if (under == null || over + under <= 0) return over;
  return over / (over + under);
}

export function evaluateHRAlert(input: HRAlertInput): HRAlertResult {
  const result = evaluateHRAlertCore(input);
  // Only the actionable HR Max Window tier is EV-gated.
  if (result.alertTier !== "officialAlert") return result;
  const marketImplied = deviggedMarketHrProb(input.overOdds, input.underOdds);
  if (marketImplied == null) return result; // no price → preserve legacy behavior
  const modelProb =
    result.diagnostics.hrConversion?.calibratedProbability ??
    result.diagnostics.hrConversion?.hrConversionProbability ??
    null;
  if (modelProb == null) return result;
  const required = marketImplied * (1 + HR_EV_EDGE_MARGIN);
  const edgePct = marketImplied > 0 ? ((modelProb - marketImplied) / marketImplied) * 100 : 0;
  if (modelProb >= required) {
    // Positive edge — keep the actionable tier; annotate for observability.
    console.log(
      `[HR_RADAR_EV_GATE] PASS ${input.playerName} game=${input.gameId} ` +
      `model=${(modelProb * 100).toFixed(1)}% mkt=${(marketImplied * 100).toFixed(1)}% edge=${edgePct.toFixed(0)}%`,
    );
    return result;
  }
  // Insufficient edge — demote HR Max Window → Building (prepare). Still
  // surfaced as context; just not graded/bet as a max-window pick.
  //
  // IMPORTANT: demoting `alertTier` alone is not enough. The orchestrator
  // persists `signalState`/`decision` (not alertTier) into the DB
  // `confidenceTier`/`signalState` columns (PEAK → strong/actionable), and the
  // grading helper `reachedHrMaxWindow` treats strong/actionable as the HR Max
  // Window tier — so an EV-demoted PEAK signal would still be graded/notified as
  // actionable. Clear every actionable marker: drop to BUILDING/PREPARE and
  // downgrade the level from ALERT → WATCH so cooldown/notifications (gated on
  // level === "ALERT") don't fire for a non-bet signal.
  console.log(
    `[HR_RADAR_EV_GATE] DEMOTE ${input.playerName} game=${input.gameId} ` +
    `model=${(modelProb * 100).toFixed(1)}% mkt=${(marketImplied * 100).toFixed(1)}% ` +
    `edge=${edgePct.toFixed(0)}% need≥${(required * 100).toFixed(1)}% → building`,
  );
  return {
    ...result,
    alertTier: "prepare",
    level: result.level === "ALERT" ? "WATCH" : result.level,
    signalState: result.signalState === "PEAK" ? "BUILDING" : result.signalState,
    decision: result.decision === "BET_NOW" ? "PREPARE" : result.decision,
    triggerReason:
      `${result.triggerReason} · EV-gated (model ${(modelProb * 100).toFixed(1)}% ` +
      `vs mkt ${(marketImplied * 100).toFixed(1)}%, edge ${edgePct.toFixed(0)}%)`,
  };
}
