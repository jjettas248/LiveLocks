import type { MLBSignal } from "@shared/mlbSignal";

export type MlbSignalUi = MLBSignal & {
  displayConfidence: string;
  displayLiveGrade: string | null;
  displayOppGrade: string | null;
  displayPitcherSignals: Array<{ label: string; color: string }>;
  displayTierBadge: string;
};

export type SignalState = "PEAK" | "BUILDING" | "FORMATION" | "COOLDOWN" | null;
export type Decision = "BET_NOW" | "PREPARE" | "MONITOR" | null;

export type HrRadarCardUi = {
  playerId: string;
  playerName: string;
  team: string;
  gameId: string;
  detectedInning: number | null;
  latestInning: number | null;
  radarScore: number;
  radarTier: string;
  radarTierLabel: string;
  radarTierColor: string;
  status: "WATCH" | "ALERT" | "CASHED" | "MISSED" | "PENDING";
  signalState: SignalState;
  decision: Decision;
  confidenceScore: number;
  formattedReason: string;
  evidenceTags: Array<{ label: string; color: string }>;
  triggerLabel: string;
  bestBook: string | null;
  bestOdds: number | null;
  hrBookCount: number;
  side: string | null;
  line: number | null;
  edge: number | null;
  enginePct: number | null;
  confidenceTier: string | null;
  hrBuildScore: number | null;
  badges: string[];
  reasons: string[];
  wasAddedToSlip: boolean;
  resolvedAt: string | null;
  hitInning: number | null;
  hitHalf: string | null;
  detectedLabel: string | null;
  scoreIncreased: boolean;
  scoreIncreaseLabel: string | null;
  peakScore: number | null;
  isHotHitter: boolean;
  hotHitterPeriod: string | null;
  hotHitterHrCount: number | null;
  onlyHomersVerified: boolean;
  ohExitVelocity: number | null;
  ohLaunchAngle: number | null;
  ohDistance: number | null;
  ohPitchType: string | null;
  alertPath: string | null;
  conversionPct: number | null;
  mode: string | null;
  dynamicState: "WATCH" | "PREPARE" | "BET_NOW" | "COOLED_OFF" | "CLOSED" | null;
  hrReadinessScore: number | null;
  hrConversionCalibrated: number | null;
  hrConversionRaw: number | null;
  remainingPA: number | null;
  pitcherVulnerability: number | null;
  decayFactor: number | null;
  dynamicDrivers: string[];
  dynamicSuppressors: string[];
  cooldownReason: string | null;
  dynamicPeakScore: number | null;
  dynamicPeakState: string | null;
  dynamicTickCount: number | null;
  dynamicLastRecompute: number | null;
  dynamicDataFreshness: number | null;
};

export type HrRadarAnalyzeViewModel = {
  alert: {
    id: string;
    playerName: string;
    team: string;
    gameId: string;
    detectedLabel: string | null;
    initialScore: number | null;
    currentScore: number | null;
    peakScore: number | null;
    scoreIncreased: boolean;
    scoreIncreaseLabel: string | null;
    confidenceTier: string;
    signalState: string;
    triggerTags: string[];
    summaryText: string | null;
    status: string;
    hitLabel: string | null;
    contactSnapshot: any;
  };
  priorABs: Array<{
    abNumber: number;
    exitVelocity: number | null;
    launchAngle: number | null;
    distance: number | null;
    outcome: string;
    isBarrel: boolean;
    isHardHit: boolean;
  }>;
  hrFactors: any;
  hrBuildScore: number | null;
  hrIntensity: string | null;
  explanationBullets: string[];
  currentInning: number | null;
};

/**
 * UI contract for HR Radar detection labels (HR Radar inning-drift fix).
 *
 *   - `detectedLabel`           : write-once on first persist; the inning we
 *                                 first noticed the player. NEVER advances
 *                                 when the score later climbs.
 *   - `scoreIncreaseLabel`      : separate, mutable; reflects when the score
 *                                 most recently climbed. Render this on its
 *                                 own row — never as part of the "Detected"
 *                                 / "Called" label.
 *
 * Use `formatDetectedLabel(detectedLabel)` for the frozen first-detection
 * inning and `formatScoreIncreaseLabel(scoreIncreaseLabel)` for the score
 * climb. The two MUST NOT be conflated in display.
 */
export function formatDetectedLabel(detectedLabel: string | null | undefined): string | null {
  return detectedLabel ?? null;
}

export function formatScoreIncreaseLabel(scoreIncreaseLabel: string | null | undefined): string | null {
  if (!scoreIncreaseLabel) return null;
  return `Score climbed ${scoreIncreaseLabel}`;
}

const PITCHER_SIGNAL_MAP: Record<string, { label: string; color: string }> = {
  DOMINANT: { label: "Dominant", color: "#ef4444" },
  K_STREAK: { label: "K Streak", color: "#f59e0b" },
  COMMAND_LOCKED: { label: "Locked In", color: "#22c55e" },
  VELOCITY_DROP: { label: "Velo Drop", color: "#f97316" },
  FATIGUE_RISK: { label: "Fatigued", color: "#f97316" },
  HARD_CONTACT: { label: "Hard Hit", color: "#ef4444" },
};

const RADAR_TIER_CONFIG: Array<{ min: number; tier: string; label: string; color: string }> = [
  { min: 7.5, tier: "imminent", label: "Imminent", color: "#ef4444" },
  { min: 5.0, tier: "strong", label: "Strong Watch", color: "#f97316" },
  { min: 3.5, tier: "building", label: "Building", color: "#eab308" },
  { min: 2.0, tier: "low", label: "Low Watch", color: "#71717a" },
  { min: 0, tier: "tracking", label: "Tracking", color: "#52525b" },
];

const TRIGGER_REASON_MAP: Record<string, string> = {
  "hard_trigger:barrel+avgEV95+inn5+score": "High contact quality + barrel + deep in game",
  "hard_trigger:barrel+avgEV95+inn5": "Barrel contact with elite EV, deep in game",
  "hard_trigger:barrel+avgEV95": "Barrel contact with elite exit velocity",
  "repeat_contact:last2ABs_EV95+_LA20-35": "Back-to-back hard, well-angled contact",
  "soft_trigger:avgEV92+score3.5": "Consistent hard contact building",
  "soft_trigger:avgEV92+score": "Hard contact pattern building",
  "hard_trigger:barrel": "Barrel contact — HR potential rising",
  "hard_trigger:avgEV95": "Elite exit velocity today",
  "hard_trigger": "Strong contact trigger detected",
  "repeat_contact": "Repeated hard contact pattern",
  "soft_trigger": "Consistent hard contact building",
  "late_game_spike": "Late-game HR window with strong contact",
  "bullpen_downgrade": "Weaker reliever now pitching",
  "fatigue_spike": "Pitcher fatigue creating opportunity",
  "park_wind_boost": "Park and wind conditions favorable",
  "park_wind": "Park and wind conditions favorable",
  "platoon_advantage": "Platoon advantage active",
  "PATH_A:multiHrShaped": "Multiple HR-shaped contact events detected",
  "PATH_B:elite+context": "Elite HR contact with favorable conditions",
  "PATH_B:missed+context": "Near-miss HR with supporting context",
  "PATH_C:lateGame+hrShaped": "Late-game HR window with quality contact",
  "watch:hrShaped": "HR-shaped contact detected — monitoring",
};

export function liveScoreToGrade(score: number): { grade: string; color: string } {
  const pct = Math.min(Math.round(score * 100 * 5), 100);
  if (pct >= 80) return { grade: "A+", color: "#22c55e" };
  if (pct >= 65) return { grade: "A", color: "#22c55e" };
  if (pct >= 50) return { grade: "B+", color: "#a3e635" };
  if (pct >= 35) return { grade: "B", color: "#f59e0b" };
  if (pct >= 20) return { grade: "C+", color: "#f59e0b" };
  return { grade: "C", color: "#94a3b8" };
}

export function oppScoreToGrade(score: number): string {
  if (score >= 80) return "A+";
  if (score >= 65) return "A";
  if (score >= 50) return "B+";
  if (score >= 35) return "B";
  if (score >= 20) return "C+";
  return "C";
}

export function radarScoreToTier(score: number): { tier: string; label: string; color: string } {
  for (const t of RADAR_TIER_CONFIG) {
    if (score >= t.min) return { tier: t.tier, label: t.label, color: t.color };
  }
  return { tier: "tracking", label: "Tracking", color: "#52525b" };
}

export function formatTriggerReason(raw: string | null | undefined): string {
  if (!raw) return "";
  for (const [prefix, label] of Object.entries(TRIGGER_REASON_MAP)) {
    if (raw.startsWith(prefix)) return label;
  }
  if (raw.startsWith("leaderboard:")) {
    const parts = raw.replace("leaderboard:", "");
    if (parts.includes("topEV")) return "Elite exit velocity today";
    if (parts.includes("topDistance")) return "Deep flyball risk";
    if (parts.includes("topBarrel")) return "Barrel pressure building";
    if (parts.includes("topHardHit")) return "Strong contact build";
    return "Leaderboard-level contact today";
  }
  if (raw.startsWith("PATH_A")) return "Multiple HR-shaped contact events detected";
  if (raw.startsWith("PATH_B:elite")) return "Elite HR contact with favorable conditions";
  if (raw.startsWith("PATH_B:missed")) return "Near-miss HR with supporting context";
  if (raw.startsWith("PATH_B")) return "Strong HR contact with favorable conditions";
  if (raw.startsWith("PATH_C")) return "Late-game HR window with quality contact";
  if (raw.startsWith("watch:hrShaped")) return "HR-shaped contact detected — monitoring";
  if (raw.startsWith("watch:")) return "Contact pattern building — monitoring";
  if (raw.includes("barrel") && raw.includes("EV")) {
    return "Barrel contact with elite exit velocity";
  }
  if (raw.includes("hard_hit") || raw.includes("hardHit")) {
    return "Hard contact pattern detected";
  }
  const cleaned = sanitizeDisplayString(raw);
  return cleaned;
}

function clampPct(val: number): number {
  const normalized = val > 1 ? val : val * 100;
  return Math.min(Math.max(normalized, 0), 100);
}

export function formatMlbDisplayValue(key: string, value: number | string | null | undefined): string {
  if (value == null) return "—";
  if (typeof value === "string") return sanitizeDisplayString(value);
  switch (key) {
    case "hardHitPct":
    case "barrelPct":
      return `${clampPct(value).toFixed(0)}%`;
    case "xBA":
    case "xSLG":
      return value.toFixed(3);
    case "exitVelocity":
    case "avgEV":
    case "maxEV":
      return `${value.toFixed(1)} mph`;
    case "launchAngle":
    case "avgLA":
      return `${value.toFixed(0)}°`;
    case "probability":
    case "enginePct":
      return `${Math.min(value > 1 ? value : value * 100, 100).toFixed(0)}%`;
    case "edge":
      return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
    case "projection":
      return value.toFixed(2);
    default:
      return String(value);
  }
}

export function sanitizeDisplayString(str: string): string {
  let cleaned = str
    .replace(/[\u0080-\u009f]/g, "")
    .replace(/\u00B7/g, "|")
    .replace(/\\u00B7/g, "|")
    .replace(/\u2713/g, "✓")
    .replace(/leaderboard:\w+/g, "")
    .replace(/score\d+(\.\d+)?/g, "")
    .replace(/inn\d+/g, "")
    .replace(/hard_trigger:\S*/g, "")
    .replace(/soft_trigger:\S*/g, "")
    .replace(/repeat_contact:\S*/g, "")
    .replace(/late_game_spike:\S*/g, "")
    .replace(/[+:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length < 3) cleaned = "Signal detected";
  return cleaned;
}

export function mapPitcherSignals(signals: string[] | null | undefined): Array<{ label: string; color: string }> {
  if (!signals || signals.length === 0) return [];
  return signals
    .map(s => PITCHER_SIGNAL_MAP[s])
    .filter((s): s is { label: string; color: string } => s != null);
}

const CONFIDENCE_DISPLAY: Record<string, string> = {
  ELITE: "Elite",
  STRONG: "Strong",
  SOLID: "Solid",
  WATCHLIST: "Watch",
};

const TIER_BADGE_MAP: Record<string, string> = {
  ELITE: "ELITE EDGE",
  STRONG: "STRONG EDGE",
  SOLID: "SOLID",
  WATCHLIST: "WATCHING",
};

export function mapMlbSignalToUi(sig: MLBSignal): MlbSignalUi {
  const liveGrade = sig.liveScore != null ? liveScoreToGrade(sig.liveScore) : null;
  const oppGrade = (sig as any).opposingScore != null ? oppScoreToGrade((sig as any).opposingScore) : null;
  const pitcherSigs = mapPitcherSignals((sig as any).pitcherSignals);
  const tier = sig.confidenceTier ?? "WATCHLIST";
  return {
    ...sig,
    displayConfidence: CONFIDENCE_DISPLAY[tier] ?? tier,
    displayLiveGrade: liveGrade ? liveGrade.grade : null,
    displayOppGrade: oppGrade,
    displayPitcherSignals: pitcherSigs,
    displayTierBadge: TIER_BADGE_MAP[tier] ?? "SIGNAL",
  };
}

export function launchAngleLabel(angle: number): { tag: string; color: string } {
  const la = Math.round(angle);
  if (la < 0) return { tag: "Ground", color: "text-muted-foreground/60" };
  if (la <= 10) return { tag: "Ground", color: "text-muted-foreground/60" };
  if (la <= 25) return { tag: "Line", color: "text-emerald-400" };
  if (la <= 40) return { tag: "Fly", color: "text-green-400" };
  return { tag: "Pop", color: "text-red-400/70" };
}

export function mapHrRadarCardToUi(player: any, type: "edge" | "watch" | "cashed"): HrRadarCardUi {
  const score = player.hrBuildScore ?? player.radarScore ?? 0;
  const tier = radarScoreToTier(score);
  const status: HrRadarCardUi["status"] =
    type === "cashed" ? "CASHED" :
    type === "edge" ? "ALERT" :
    "WATCH";

  const evidenceTags: Array<{ label: string; color: string }> = [];
  if (player.hardHitEvents > 0) evidenceTags.push({ label: `${player.hardHitEvents} Hard Hit${player.hardHitEvents > 1 ? "s" : ""}`, color: "text-orange-400 bg-orange-500/10" });
  if (player.barrelCount > 0 || (player.factors?.barrels ?? 0) > 0) {
    const bc = player.barrelCount ?? player.factors?.barrels ?? 0;
    evidenceTags.push({ label: `${bc} Barrel${bc > 1 ? "s" : ""}`, color: "text-red-400 bg-red-500/10" });
  }
  if (player.parkFactor != null && player.parkFactor > 1) evidenceTags.push({ label: "Park Boost", color: "text-green-400 bg-green-500/10" });
  if (player.windFactor === "favorable") evidenceTags.push({ label: "Wind Out", color: "text-cyan-400 bg-cyan-500/10" });

  const derivedState: SignalState = type === "cashed" ? null :
    score >= 4.5 ? "PEAK" : score >= 3.5 ? "BUILDING" : "FORMATION";
  const derivedDecision: Decision = type === "cashed" ? null :
    derivedState === "PEAK" ? "BET_NOW" : derivedState === "BUILDING" ? "PREPARE" : "MONITOR";
  const derivedConfidence = Math.max(1, Math.min(10, Math.round(score * 2)));

  return {
    playerId: player.playerId,
    playerName: player.playerName,
    team: player.team ?? player.teamAbbr ?? "",
    gameId: player.gameId ?? "",
    detectedInning: player.detectedInning ?? player.inning ?? null,
    latestInning: player.latestInning ?? player.inning ?? null,
    radarScore: score,
    radarTier: tier.tier,
    radarTierLabel: tier.label,
    radarTierColor: tier.color,
    status,
    signalState: player.signalState ?? derivedState,
    decision: player.decision ?? derivedDecision,
    confidenceScore: player.confidenceScore ?? derivedConfidence,
    formattedReason: player.formattedReason ?? formatTriggerReason(player.triggerReason),
    evidenceTags,
    triggerLabel: formatTriggerReason(player.triggerReason),
    bestBook: player.sportsbook ?? null,
    bestOdds: player.overOdds ?? null,
    hrBookCount: player.availableBooks ?? 0,
    side: player.side ?? "OVER",
    line: player.line ?? 0.5,
    edge: player.edge ?? null,
    enginePct: player.engineProbability ?? null,
    confidenceTier: player.confidenceTier ?? null,
    hrBuildScore: score,
    badges: Array.isArray(player.badges) ? player.badges : [],
    reasons: (player.explanationBullets ?? player.reasons ?? []).map((r: string) => sanitizeDisplayString(r)),
    wasAddedToSlip: false,
    resolvedAt: player.resolvedAt ?? null,
    hitInning: player.hitInning ?? null,
    hitHalf: player.hitHalf ?? null,
    detectedLabel: player.detectedLabel ?? null,
    scoreIncreased: player.scoreIncreased ?? false,
    scoreIncreaseLabel: player.scoreIncreaseLabel ?? null,
    peakScore: player.peakReadinessScore ? parseFloat(player.peakReadinessScore) : player.peakScore ?? null,
    isHotHitter: player.isHotHitter ?? false,
    hotHitterPeriod: player.hotHitterPeriod ?? null,
    hotHitterHrCount: player.hotHitterHrCount ?? null,
    onlyHomersVerified: player.onlyHomersVerified ?? false,
    ohExitVelocity: player.ohExitVelocity ?? null,
    ohLaunchAngle: player.ohLaunchAngle ?? null,
    ohDistance: player.ohDistance ?? null,
    ohPitchType: player.ohPitchType ?? null,
    alertPath: player.alertPath ?? null,
    conversionPct: player.conversionPct ?? (player.hrProbability != null ? player.hrProbability / 100 : null),
    mode: player.mode ?? null,
    dynamicState: player.hrAlert?.currentState ?? null,
    hrReadinessScore: player.hrAlert?.hrReadinessScore ?? null,
    hrConversionCalibrated: player.hrAlert?.hrConversionProbabilityCalibrated ?? null,
    hrConversionRaw: player.hrAlert?.hrConversionProbabilityRaw ?? null,
    remainingPA: player.hrAlert?.remainingPAExpectation ?? null,
    pitcherVulnerability: player.hrAlert?.pitcherHrVulnerability ?? null,
    decayFactor: player.hrAlert?.decayFactor ?? null,
    dynamicDrivers: player.hrAlert?.positiveDrivers ?? [],
    dynamicSuppressors: player.hrAlert?.negativeSuppressors ?? [],
    cooldownReason: player.hrAlert?.cooldownReason ?? null,
    dynamicPeakScore: player.hrAlert?.peakScore ?? null,
    dynamicPeakState: player.hrAlert?.peakState ?? null,
    dynamicTickCount: player.hrAlert?.tickCount ?? null,
    dynamicLastRecompute: player.hrAlert?.lastRecomputeAt ?? null,
    dynamicDataFreshness: player.hrAlert?.dataFreshnessMs ?? null,
  };
}

export function mapAlertToUi(alert: any): HrRadarCardUi {
  const score = alert.hrBuildScore ?? 0;
  const tier = radarScoreToTier(score);
  const status: HrRadarCardUi["status"] =
    alert.outcome === "HR" ? "CASHED" :
    alert.outcome === "NO_HR" ? "MISSED" :
    alert.alertType === "HR_EARLY" ? "ALERT" :
    "WATCH";

  const evidenceTags: Array<{ label: string; color: string }> = [];
  if (alert.factors) {
    if (alert.factors.barrels > 0) evidenceTags.push({ label: `${alert.factors.barrels} Barrel${alert.factors.barrels > 1 ? "s" : ""}`, color: "text-red-400 bg-red-500/10" });
    if (alert.factors.hardHits > 0) evidenceTags.push({ label: `${alert.factors.hardHits} Hard Hit${alert.factors.hardHits > 1 ? "s" : ""}`, color: "text-orange-400 bg-orange-500/10" });
    if (alert.factors.deepFlyouts > 0) evidenceTags.push({ label: `${alert.factors.deepFlyouts} Deep Fly${alert.factors.deepFlyouts > 1 ? "s" : ""}`, color: "text-amber-400 bg-amber-500/10" });
    if ((alert.factors.maxEV ?? 0) >= 100) evidenceTags.push({ label: `${alert.factors.maxEV?.toFixed(0)} EV`, color: "text-red-400 bg-red-500/10" });
    if ((alert.factors.platoonBoost ?? 0) > 0) evidenceTags.push({ label: "Platoon Edge", color: "text-blue-400 bg-blue-500/10" });
    if ((alert.factors.pitcherFatigueBoost ?? 0) > 0) evidenceTags.push({ label: "Pitcher Fatigue", color: "text-purple-400 bg-purple-500/10" });
    if ((alert.factors.parkWindBoost ?? 0) > 0) evidenceTags.push({ label: "Park/Wind Boost", color: "text-cyan-400 bg-cyan-500/10" });
  }

  const alertSignalState: SignalState = alert.signalState ?? (
    status === "CASHED" || status === "MISSED" ? null :
    alert.alertType === "HR_EARLY" ? "PEAK" : "FORMATION"
  );
  const alertDecision: Decision = alert.decision ?? (
    alertSignalState === "PEAK" ? "BET_NOW" :
    alertSignalState === "BUILDING" ? "PREPARE" :
    alertSignalState === "FORMATION" ? "MONITOR" : null
  );
  const alertConfidence = alert.confidenceScore ?? Math.max(1, Math.min(10, Math.round(score * 2)));

  return {
    playerId: alert.playerId,
    playerName: alert.playerName,
    team: alert.teamAbbr ?? "",
    gameId: alert.gameId ?? "",
    detectedInning: alert.inning ?? null,
    latestInning: alert.inning ?? null,
    radarScore: score,
    radarTier: tier.tier,
    radarTierLabel: tier.label,
    radarTierColor: tier.color,
    status,
    signalState: alertSignalState,
    decision: alertDecision,
    confidenceScore: alertConfidence,
    formattedReason: alert.formattedReason ?? formatTriggerReason(alert.triggerReason),
    evidenceTags,
    triggerLabel: formatTriggerReason(alert.triggerReason),
    bestBook: null,
    bestOdds: null,
    hrBookCount: 0,
    side: "OVER",
    line: 0.5,
    edge: null,
    enginePct: null,
    confidenceTier: null,
    hrBuildScore: score,
    badges: [],
    reasons: [],
    wasAddedToSlip: false,
    resolvedAt: alert.resolvedAt ?? null,
    hitInning: alert.hitInning ?? null,
    hitHalf: alert.hitHalf ?? null,
    detectedLabel: alert.detectedLabel ?? null,
    scoreIncreased: alert.scoreIncreased ?? false,
    scoreIncreaseLabel: alert.scoreIncreaseLabel ?? null,
    peakScore: alert.peakScore ?? alert.peakReadinessScore ? parseFloat(alert.peakReadinessScore ?? alert.peakScore ?? "0") : null,
    isHotHitter: alert.isHotHitter ?? false,
    hotHitterPeriod: alert.hotHitterPeriod ?? null,
    hotHitterHrCount: alert.hotHitterHrCount ?? null,
    onlyHomersVerified: alert.onlyHomersVerified ?? false,
    ohExitVelocity: alert.ohExitVelocity ?? null,
    ohLaunchAngle: alert.ohLaunchAngle ?? null,
    ohDistance: alert.ohDistance ?? null,
    ohPitchType: alert.ohPitchType ?? null,
    alertPath: alert.alertPath ?? null,
    conversionPct: alert.conversionPct ?? null,
    mode: alert.mode ?? null,
    dynamicState: null,
    hrReadinessScore: null,
    hrConversionCalibrated: null,
    hrConversionRaw: null,
    remainingPA: null,
    pitcherVulnerability: null,
    decayFactor: null,
    dynamicDrivers: [],
    dynamicSuppressors: [],
    cooldownReason: null,
    dynamicPeakScore: null,
    dynamicPeakState: null,
    dynamicTickCount: null,
    dynamicLastRecompute: null,
    dynamicDataFreshness: null,
  };
}
