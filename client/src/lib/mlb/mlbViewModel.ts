import type { MLBSignal } from "@shared/mlbSignal";
import {
  liveScoreToGrade,
  oppScoreToGrade,
  radarScoreToTier,
  mapPitcherSignals,
  sanitizeDisplayString,
  formatTriggerReason,
  launchAngleLabel,
} from "@/lib/mlbUiMappers";

export function normalizePct(val: number): number {
  if (val > 1 && val <= 100) return val;
  if (val <= 1) return val * 100;
  return Math.min(val, 100);
}

const MARKET_LABELS: Record<string, string> = {
  hits: "Hits",
  total_bases: "Total Bases",
  home_runs: "Home Runs",
  rbi: "RBI",
  runs: "Runs",
  stolen_bases: "Stolen Bases",
  batter_strikeouts: "Strikeouts",
  pitcher_strikeouts: "Pitcher Strikeouts",
  pitcher_k: "Pitcher Strikeouts",
  pitcher_outs: "Pitcher Outs",
  hits_allowed: "Hits Allowed",
  walks_allowed: "Walks Allowed",
  hr_allowed: "HR Allowed",
  earned_runs: "Earned Runs",
  hrr: "H+R+RBI",
  hr: "Home Runs",
};

const MARKET_SHORT: Record<string, string> = {
  hits: "Hits",
  total_bases: "TB",
  home_runs: "HR",
  rbi: "RBI",
  runs: "Runs",
  stolen_bases: "SB",
  batter_strikeouts: "Ks",
  pitcher_strikeouts: "Pitcher K",
  pitcher_k: "Pitcher K",
  pitcher_outs: "Outs",
  hits_allowed: "Hits Alwd",
  walks_allowed: "BB Alwd",
  hr_allowed: "HR Alwd",
  earned_runs: "ER",
  hrr: "H+R+RBI",
  hr: "HR",
};

const BADGE_DISPLAY: Record<string, { label: string; color: string } | null> = {
  "Good Contact": { label: "Solid Contact", color: "#22c55e" },
  "Strong EV": { label: "Hard Hitter", color: "#22c55e" },
  "High Bat Speed": { label: "Quick Bat", color: "#22c55e" },
  "Elite Bat Speed": { label: "Elite Bat", color: "#22c55e" },
  "Explosive Bat Speed": { label: "Elite Bat", color: "#22c55e" },
  "High Barrel": { label: "Barrel Machine", color: "#22c55e" },
  "Handedness Edge": { label: "Platoon Edge", color: "#3b82f6" },
  "Pitch-Type Edge": { label: "Pitch Matchup ✓", color: "#3b82f6" },
  "Park Boost": { label: "Park Factor ▲", color: "#a3e635" },
  "Hot Form": { label: "Hot Streak", color: "#f59e0b" },
  "BvP Boost": { label: "BvP History ✓", color: "#a3e635" },
  "Sweet Spot Lift": { label: "Ideal Launch", color: "#22c55e" },
  "Pitcher Deterioration Spot": { label: "Pitcher Fading", color: "#f59e0b" },
  "Bullpen Boost": { label: "Weak Bullpen", color: "#a3e635" },
  "Low Bat Speed": null,
  "Poor Split": { label: "Wrong Side", color: "#ef4444" },
  "Pitch-Type Risk": { label: "Pitch Mismatch", color: "#ef4444" },
  "Bad Park": { label: "Park Factor ▼", color: "#ef4444" },
  "Cold Form": { label: "Cold Streak", color: "#ef4444" },
  "Tough Bullpen": { label: "Strong Bullpen", color: "#ef4444" },
  "High K Risk": { label: "Strikeout Prone", color: "#ef4444" },
  "Weak Contact": { label: "Soft Contact", color: "#ef4444" },
  "Pitcher Suppression Risk": { label: "Dominant Pitcher", color: "#ef4444" },
  "Late-Lineup Risk": { label: "Low in Order", color: "#f59e0b" },
};

const TIER_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  ELITE:     { bg: "hsl(var(--tier-elite) / 0.13)",  text: "hsl(var(--tier-elite))",  border: "hsl(var(--tier-elite) / 0.6)" },
  STRONG:    { bg: "hsl(var(--tier-strong) / 0.13)", text: "hsl(var(--tier-strong))", border: "hsl(var(--tier-strong) / 0.6)" },
  SOLID:     { bg: "hsl(var(--tier-value) / 0.13)",  text: "hsl(var(--tier-value))",  border: "hsl(var(--tier-value) / 0.6)" },
  WATCHLIST: { bg: "hsl(var(--tier-watch) / 0.13)",  text: "hsl(var(--tier-watch))",  border: "hsl(var(--tier-watch) / 0.6)" },
};

const SIDE_STYLES: Record<string, { color: string; bg: string }> = {
  OVER: { color: "#4ade80", bg: "rgba(34,197,94,0.1)" },
  UNDER: { color: "#60a5fa", bg: "rgba(59,130,246,0.1)" },
};

const AB_OUTCOME_STYLE: Record<string, { label: string; color: string }> = {
  hit: { label: "H", color: "#22c55e" },
  single: { label: "1B", color: "#22c55e" },
  double: { label: "2B", color: "#a3e635" },
  triple: { label: "3B", color: "#f59e0b" },
  home_run: { label: "HR", color: "#f97316" },
  strikeout: { label: "K", color: "#ef4444" },
  walk: { label: "BB", color: "#3b82f6" },
  flyout: { label: "FO", color: "#6b7280" },
  groundout: { label: "GO", color: "#6b7280" },
  lineout: { label: "LO", color: "#6b7280" },
  popout: { label: "PO", color: "#6b7280" },
  field_out: { label: "Out", color: "#6b7280" },
};

const PITCHER_SIGNAL_DISPLAY: Record<string, { label: string; color: string }> = {
  DOMINANT: { label: "Dominant", color: "#ef4444" },
  K_STREAK: { label: "K Streak", color: "#f59e0b" },
  COMMAND_LOCKED: { label: "Locked In", color: "#22c55e" },
  VELOCITY_DROP: { label: "Velo Drop", color: "#f97316" },
  FATIGUE_RISK: { label: "Fatigued", color: "#f97316" },
  HARD_CONTACT: { label: "Hard Hit", color: "#ef4444" },
};

export type SignalViewModel = {
  id: string;
  playerId: string;
  playerName: string;
  gameId: string;
  matchup: string | null;
  market: string;
  marketLabel: string;
  marketShort: string;
  side: string;
  sideStyle: { color: string; bg: string };
  bookLine: number | null;
  sportsbook: string | null;
  probability: number;
  probabilityDisplay: string;
  edge: number | null;
  edgeDisplay: string | null;
  projection: number | null;
  tierKey: string;
  tierStyle: { bg: string; text: string; border: string };
  tierBadge: string;
  liveGrade: { grade: string; color: string } | null;
  oppGrade: string | null;
  // ── MLB Canonical Display Contract (server-owned) ──────────────────────
  // These fields mirror the server-stamped display contract verbatim. UI
  // surfaces MUST render these instead of re-deriving from signalScore.
  displaySide: "OVER" | "UNDER";
  displayProbability: number;
  displayProbabilityLabel: string;
  overProbability: number;
  underProbability: number;
  displayGrade: "A+" | "A" | "B+" | "B" | "B-" | "Watch";
  displayGradeColor: string;
  isBettable: boolean;
  isWatchOnly: boolean;
  displayDrivers: string[];
  detectionLabel: string;
  badges: Array<{ label: string; color: string }>;
  pitcherSignals: Array<{ label: string; color: string }>;
  smartTags: string[];
  primaryReason: string;
  stale: boolean;
  alreadyHit: boolean;
  actionable: boolean;
  inning: number;
  isTopInning: boolean;
  feedTags: string[];
  isPitcherMarket: boolean;
  isHRMarket: boolean;
  hrIntensity: string | null;
  hrBuildScore: number | null;
  liveScore: number;
  eventBoost: number;
  opportunityScore: number;
  overOdds: number | null;
  underOdds: number | null;
  currentStats: MLBSignal["currentStats"];
  priorABResults: AtBatViewModel[];
  pitchMix: MLBSignal["pitchMix"];
  pitchMatchupRatings: MLBSignal["pitchMatchupRatings"];
  drivers: Record<string, number>;
  raw: MLBSignal;
};

export type AtBatViewModel = {
  outcome: string;
  outcomeLabel: string;
  outcomeColor: string;
  exitVelocity: number | null;
  exitVelocityDisplay: string | null;
  launchAngle: number | null;
  launchLabel: { tag: string; color: string } | null;
  distance: number | null;
  distanceDisplay: string | null;
  pitchType: string | null;
  pitchSpeed: number | null;
  pitchChipColor: string;
};

export type HrRadarViewModel = {
  playerId: string;
  playerName: string;
  team: string;
  gameId: string;
  detectedInning: number | null;
  latestInning: number | null;
  radarScore: number;
  radarScoreDisplay: string;
  radarTier: string;
  radarTierLabel: string;
  radarTierColor: string;
  status: "WATCH" | "ALERT" | "CASHED" | "MISSED" | "PENDING";
  statusLabel: string;
  evidenceTags: Array<{ label: string; color: string }>;
  triggerLabel: string;
  bestBook: string | null;
  bestOdds: number | null;
  hrBookCount: number;
  side: string | null;
  line: number | null;
  edge: number | null;
  edgeDisplay: string | null;
  enginePct: number | null;
  enginePctDisplay: string | null;
  confidenceTier: string | null;
  hrBuildScore: number | null;
  badges: string[];
  reasons: string[];
  wasAddedToSlip: boolean;
};

export type GameViewModel = {
  gameId: string;
  homeTeam: string;
  awayTeam: string;
  homeAbbr: string;
  awayAbbr: string;
  matchupLabel: string;
  homeScore: number | null;
  awayScore: number | null;
  scoreLabel: string;
  inning: number;
  isTopInning: boolean;
  inningLabel: string;
  status: string;
  startTime: string | null;
  venue: string | null;
  weatherSummary: string | null;
  temperature: string | null;
  windLabel: string | null;
  humidityLabel: string | null;
  pitcherHome: string | null;
  pitcherAway: string | null;
  homePitcherHand: string | null;
  awayPitcherHand: string | null;
  hasOdds: boolean;
  signalCount: number;
  gameCardTags: string[];
};

export type PitchMatchupViewModel = {
  pitchType: string;
  pitchLabel: string;
  usage: string;
  velocity: string | null;
  rating: "strong" | "neutral" | "weak";
  ratingColor: string;
  ratingBorder: string;
  ratingArrow: string;
  advantageLabel: string;
};

export type CalcHydrationPayload = {
  gameId: string;
  playerId: string;
  playerName: string;
  teamAbbr: string;
  teamSide: "home" | "away";
  market: string;
  sportsbook: string | null;
  line: number | null;
};

const PITCH_LABELS: Record<string, string> = {
  FF: "4-Seam", SI: "Sinker", FC: "Cutter", SL: "Slider",
  CU: "Curve", CH: "Change", FS: "Splitter", KC: "Knuckle Curve",
  KN: "Knuckle", EP: "Eephus", ST: "Sweeper", SV: "Slurve",
};

const STATUS_LABELS: Record<string, string> = {
  WATCH: "WATCHING",
  ALERT: "ACTIVE ALERT",
  CASHED: "CASHED",
  MISSED: "MISSED",
  PENDING: "PENDING",
};

const MARKET_NORMALIZE: Record<string, string> = {
  pitcher_k: "pitcher_strikeouts",
  hr: "home_runs",
};

export function normalizeMarket(market: string): string {
  return MARKET_NORMALIZE[market] ?? market;
}

// Server-owned displayGrade → color (matches deriveDisplayGrade tiers).
const DISPLAY_GRADE_COLORS: Record<string, string> = {
  "A+": "#eab308",   // elite
  "A":  "#22c55e",   // strong (top)
  "B+": "#a3e635",   // strong (mid)
  "B":  "#14b8a6",   // lean (top)
  "B-": "#60a5fa",   // lean (low)
  "Watch": "#71717a",
};

export function buildSignalViewModel(sig: MLBSignal): SignalViewModel {
  const tierKey = sig.confidenceTier ?? "WATCHLIST";
  const tierStyle = TIER_COLORS[tierKey] ?? TIER_COLORS.WATCHLIST;
  // ── Display contract (server-owned). Fall back to recommendedSide /
  // calibrated probabilities only when the server hasn't stamped the
  // contract yet (cache rollover during deploy). NEVER recompute grade
  // from signalScore or liveScore on the client.
  const displaySide: "OVER" | "UNDER" = sig.displaySide
    ?? (sig.recommendedSide === "UNDER" ? "UNDER" : "OVER");
  const sideStyle = SIDE_STYLES[displaySide] ?? SIDE_STYLES.OVER;
  const marketLabel = MARKET_LABELS[sig.market] ?? sig.market;
  const marketShort = MARKET_SHORT[sig.market] ?? sig.market;
  const matchup = sig.awayAbbr && sig.homeAbbr ? `${sig.awayAbbr} @ ${sig.homeAbbr}` : null;
  const liveGrade = sig.liveScore != null ? liveScoreToGrade(sig.liveScore) : null;
  const oppGradeVal = (sig as any).opposingScore != null ? oppScoreToGrade((sig as any).opposingScore) : null;
  const pitcherSigs = mapPitcherSignals((sig as any).pitcherSignals);
  const isPitcherMarket = sig.market.startsWith("pitcher_") || sig.market === "hits_allowed" || sig.market === "walks_allowed" || sig.market === "hr_allowed";
  const isHRMarket = sig.market === "home_runs" || sig.market === "hrr" || sig.market === "hr";
  const overProbRaw = sig.overProbability ?? sig.calibratedProbabilityOver
    ?? (displaySide === "OVER" ? sig.enginePct : Math.max(0, 100 - sig.enginePct));
  const underProbRaw = sig.underProbability ?? sig.calibratedProbabilityUnder
    ?? (displaySide === "UNDER" ? sig.enginePct : Math.max(0, 100 - sig.enginePct));
  const overProbability = normalizePct(overProbRaw);
  const underProbability = normalizePct(underProbRaw);
  const displayProbability = sig.displayProbability != null
    ? normalizePct(sig.displayProbability)
    : (displaySide === "OVER" ? overProbability : underProbability);
  const displayGrade = (sig.displayGrade ?? "Watch") as SignalViewModel["displayGrade"];
  const isBettable = sig.isBettable ?? (displayProbability >= 50 && (sig.signalTier ?? "watch") !== "watch");
  const isWatchOnly = sig.isWatchOnly ?? !isBettable;
  const displayDrivers = sig.displayDrivers ?? [];
  const prob = displayProbability;
  const visibleBadges = (sig.badges ?? [])
    .map(b => BADGE_DISPLAY[b])
    .filter((b): b is { label: string; color: string } => b != null)
    .slice(0, 3);

  const tierBadgeMap: Record<string, string> = {
    ELITE: "ELITE EDGE",
    STRONG: "STRONG EDGE",
    SOLID: "SOLID",
    WATCHLIST: "WATCHING",
  };

  return {
    id: `${sig.playerId}-${sig.market}-${sig.gameId}`,
    playerId: sig.playerId,
    playerName: sig.playerName,
    gameId: sig.gameId,
    matchup,
    market: sig.market,
    marketLabel,
    marketShort,
    side: displaySide,
    sideStyle,
    bookLine: sig.bookLine,
    sportsbook: sig.sportsbook,
    probability: prob,
    probabilityDisplay: `${prob.toFixed(0)}%`,
    displaySide,
    displayProbability,
    displayProbabilityLabel: `${displayProbability.toFixed(0)}%`,
    overProbability,
    underProbability,
    displayGrade,
    displayGradeColor: DISPLAY_GRADE_COLORS[displayGrade] ?? "#71717a",
    isBettable,
    isWatchOnly,
    displayDrivers,
    edge: sig.edge,
    edgeDisplay: (() => {
      const BATTER_OVER = ["hits", "total_bases", "home_runs", "hrr", "batter_strikeouts"];
      if (BATTER_OVER.includes(sig.market) && sig.signalScore != null) return `Signal ${sig.signalScore}`;
      return sig.edge != null ? `${sig.edge > 0 ? "+" : ""}${sig.edge.toFixed(1)}%` : null;
    })(),
    projection: sig.projection,
    tierKey,
    tierStyle,
    tierBadge: tierBadgeMap[tierKey] ?? "SIGNAL",
    liveGrade,
    oppGrade: oppGradeVal,
    detectionLabel: `${sig.recommendedSide} ${sig.bookLine ?? ""} ${marketLabel}`.trim(),
    badges: visibleBadges,
    pitcherSignals: pitcherSigs,
    smartTags: (sig.smartTags ?? []).map(t => sanitizeDisplayString(t)).filter(t => t.length >= 3),
    primaryReason: sig.primaryReason ? sanitizeDisplayString(sig.primaryReason) : "",
    stale: sig.stale ?? false,
    alreadyHit: sig.alreadyHit ?? false,
    actionable: sig.actionable ?? false,
    inning: sig.inning,
    isTopInning: sig.isTopInning,
    feedTags: sig.feedTags ?? [],
    isPitcherMarket,
    isHRMarket,
    hrIntensity: sig.hrIntensity ?? null,
    hrBuildScore: sig.hrBuildScore ?? null,
    liveScore: sig.liveScore ?? 0,
    eventBoost: sig.eventBoost ?? 0,
    opportunityScore: sig.opportunityScore ?? 0,
    overOdds: sig.overOdds,
    underOdds: sig.underOdds,
    currentStats: sig.currentStats,
    priorABResults: buildAtBatLogViewModel(sig.priorABResults ?? [], sig.pitchMatchupRatings),
    pitchMix: sig.pitchMix,
    pitchMatchupRatings: sig.pitchMatchupRatings,
    drivers: sig.drivers ?? {},
    raw: sig,
  };
}

export function buildAtBatLogViewModel(
  atBats: Array<{
    outcome: string;
    exitVelocity: number | null;
    launchAngle: number | null;
    pitchType: string | null;
    pitchSpeed: number | null;
    distance?: number | null;
  }>,
  pitchMatchupRatings?: MLBSignal["pitchMatchupRatings"]
): AtBatViewModel[] {
  return atBats.map(ab => {
    const style = AB_OUTCOME_STYLE[ab.outcome] ?? { label: ab.outcome ?? "?", color: "#6b7280" };
    const la = ab.launchAngle != null ? launchAngleLabel(ab.launchAngle) : null;
    // Server now emits PitchMatchupRating objects { rating, favor, score }.
    // Extract `rating` for chip coloring (color semantic unchanged).
    const ratingEntry = ab.pitchType ? pitchMatchupRatings?.[ab.pitchType] : null;
    const matchupRating = (ratingEntry && typeof ratingEntry === "object" && "rating" in ratingEntry)
      ? (ratingEntry as any).rating as "strong" | "neutral" | "weak"
      : null;
    const pitchRating = getPitchChipColor(ab.pitchType, matchupRating);
    return {
      outcome: ab.outcome,
      outcomeLabel: style.label,
      outcomeColor: style.color,
      exitVelocity: ab.exitVelocity,
      exitVelocityDisplay: ab.exitVelocity != null ? `${Math.round(ab.exitVelocity)} mph` : null,
      launchAngle: ab.launchAngle,
      launchLabel: la,
      distance: (ab as any).distance ?? null,
      distanceDisplay: (ab as any).distance != null ? `${Math.round((ab as any).distance)} ft` : null,
      pitchType: ab.pitchType,
      pitchSpeed: ab.pitchSpeed,
      pitchChipColor: pitchRating,
    };
  });
}

function getPitchChipColor(pitchType: string | null, matchupRating?: "strong" | "neutral" | "weak" | null): string {
  if (!pitchType) return "#6b7280";
  if (matchupRating === "strong") return "#22c55e";
  if (matchupRating === "weak") return "#ef4444";
  const upper = pitchType.toUpperCase();
  if (["FF", "SI", "FC"].includes(upper)) return "#60a5fa";
  if (["SL", "CU", "ST", "SV", "KC"].includes(upper)) return "#f59e0b";
  if (["CH", "FS", "KN"].includes(upper)) return "#a3e635";
  return "#94a3b8";
}

export function buildHrRadarViewModel(player: any, type: "edge" | "watch" | "cashed" | "missed"): HrRadarViewModel {
  const score = player.hrBuildScore ?? player.radarScore ?? 0;
  const tier = radarScoreToTier(score);
  const statusMap: Record<string, HrRadarViewModel["status"]> = {
    edge: "ALERT",
    watch: "WATCH",
    cashed: "CASHED",
    missed: "MISSED",
  };
  const status = statusMap[type] ?? "PENDING";

  const evidenceTags: Array<{ label: string; color: string }> = [];
  const hh = player.hardHitEvents ?? player.factors?.hardHits ?? 0;
  const bc = player.barrelCount ?? player.factors?.barrels ?? 0;
  if (hh > 0) evidenceTags.push({ label: `${hh} Hard Hit${hh > 1 ? "s" : ""}`, color: "text-orange-400 bg-orange-500/10" });
  if (bc > 0) evidenceTags.push({ label: `${bc} Barrel${bc > 1 ? "s" : ""}`, color: "text-red-400 bg-red-500/10" });
  if (player.parkFactor != null && player.parkFactor > 1) evidenceTags.push({ label: "Park Boost", color: "text-green-400 bg-green-500/10" });
  if (player.windFactor === "favorable") evidenceTags.push({ label: "Wind Out", color: "text-cyan-400 bg-cyan-500/10" });
  if (player.factors?.deepFlyouts > 0) evidenceTags.push({ label: `${player.factors.deepFlyouts} Deep Fly${player.factors.deepFlyouts > 1 ? "s" : ""}`, color: "text-amber-400 bg-amber-500/10" });
  if ((player.factors?.maxEV ?? 0) >= 100) evidenceTags.push({ label: `${player.factors?.maxEV?.toFixed(0)} EV`, color: "text-red-400 bg-red-500/10" });
  if ((player.factors?.platoonBoost ?? 0) > 0) evidenceTags.push({ label: "Platoon Edge", color: "text-blue-400 bg-blue-500/10" });
  if ((player.factors?.pitcherFatigueBoost ?? 0) > 0) evidenceTags.push({ label: "Pitcher Fatigue", color: "text-purple-400 bg-purple-500/10" });
  if ((player.factors?.parkWindBoost ?? 0) > 0) evidenceTags.push({ label: "Park/Wind Boost", color: "text-cyan-400 bg-cyan-500/10" });

  const edgeVal = player.edge ?? null;
  const engPct = player.engineProbability ?? null;

  return {
    playerId: player.playerId,
    playerName: player.playerName,
    team: player.team ?? player.teamAbbr ?? "",
    gameId: player.gameId ?? "",
    detectedInning: player.detectedInning ?? player.inning ?? null,
    latestInning: player.latestInning ?? player.inning ?? null,
    radarScore: score,
    radarScoreDisplay: `${score.toFixed(1)}/10`,
    radarTier: tier.tier,
    radarTierLabel: tier.label,
    radarTierColor: tier.color,
    status,
    statusLabel: STATUS_LABELS[status] ?? status,
    evidenceTags,
    triggerLabel: formatTriggerReason(player.triggerReason),
    bestBook: player.sportsbook ?? null,
    bestOdds: player.overOdds ?? null,
    hrBookCount: player.availableBooks ?? 0,
    side: player.side ?? "OVER",
    line: player.line ?? 0.5,
    edge: edgeVal,
    edgeDisplay: edgeVal != null ? `${edgeVal > 0 ? "+" : ""}${edgeVal.toFixed(1)}%` : null,
    enginePct: engPct,
    enginePctDisplay: engPct != null ? `${normalizePct(engPct).toFixed(0)}%` : null,
    confidenceTier: player.confidenceTier ?? null,
    hrBuildScore: score,
    badges: Array.isArray(player.badges) ? player.badges : [],
    reasons: (player.explanationBullets ?? player.reasons ?? []).map((r: string) => sanitizeDisplayString(r)),
    wasAddedToSlip: false,
  };
}

export function buildGameViewModel(game: any): GameViewModel {
  const homeAbbr = game.homeAbbr ?? "";
  const awayAbbr = game.awayAbbr ?? "";
  const inningHalf = game.isTopInning ? "Top" : "Bot";
  const inningLabel = game.status === "live" ? `${inningHalf} ${game.inning}` : game.status === "final" ? "Final" : game.startTime ?? "Pregame";

  return {
    gameId: game.gameId,
    homeTeam: game.homeTeam ?? "",
    awayTeam: game.awayTeam ?? "",
    homeAbbr,
    awayAbbr,
    matchupLabel: `${awayAbbr} @ ${homeAbbr}`,
    homeScore: game.homeScore ?? null,
    awayScore: game.awayScore ?? null,
    scoreLabel: game.homeScore != null ? `${game.awayScore ?? 0} - ${game.homeScore ?? 0}` : "—",
    inning: game.inning ?? 0,
    isTopInning: game.isTopInning ?? true,
    inningLabel,
    status: game.status ?? "pregame",
    startTime: game.startTime ?? null,
    venue: game.venue ?? null,
    weatherSummary: game.weatherSummary ?? null,
    temperature: game.weather?.temperature != null ? `${game.weather.temperature}°F` : null,
    windLabel: game.weather?.windSpeed != null ? `${game.weather.windSpeed} mph ${game.weather.windDirection ?? ""}`.trim() : null,
    humidityLabel: game.weather?.humidity != null ? `${game.weather.humidity}%` : null,
    pitcherHome: game.pitcherHome ?? null,
    pitcherAway: game.pitcherAway ?? null,
    homePitcherHand: game.homePitcherHand ?? null,
    awayPitcherHand: game.awayPitcherHand ?? null,
    hasOdds: game.hasOdds ?? false,
    signalCount: game.signalCount ?? 0,
    gameCardTags: game.gameCardTags ?? [],
  };
}

export function buildPitchMatchupViewModel(
  pitchMix: Array<{ pitchType: string; percentage: number; avgVelocity: number | null }> | null,
  ratings: Record<string, "strong" | "neutral" | "weak"> | null,
  isPitcherMarket: boolean
): PitchMatchupViewModel[] {
  if (!pitchMix) return [];
  return pitchMix
    .sort((a, b) => b.percentage - a.percentage)
    .slice(0, 5)
    .map(p => {
      const rating = ratings?.[p.pitchType] ?? "neutral";
      const ratingConfig = {
        strong: {
          color: "rgba(34,197,94,0.6)",
          border: "rgba(34,197,94,0.6)",
          arrow: "▲",
          label: isPitcherMarket ? "Pitcher +" : "Batter +",
        },
        weak: {
          color: "rgba(239,68,68,0.5)",
          border: "rgba(239,68,68,0.5)",
          arrow: "▼",
          label: isPitcherMarket ? "Pitcher −" : "Batter −",
        },
        neutral: {
          color: "rgba(148,163,184,0.3)",
          border: "rgba(148,163,184,0.3)",
          arrow: "",
          label: "Neutral",
        },
      };
      const config = ratingConfig[rating];
      return {
        pitchType: p.pitchType,
        pitchLabel: PITCH_LABELS[p.pitchType] ?? p.pitchType,
        usage: `${p.percentage.toFixed(0)}%`,
        velocity: p.avgVelocity != null ? `${p.avgVelocity.toFixed(0)} mph` : null,
        rating,
        ratingColor: config.color,
        ratingBorder: config.border,
        ratingArrow: config.arrow,
        advantageLabel: config.label,
      };
    });
}

export function buildTopOpportunitiesViewModel(signals: SignalViewModel[]): SignalViewModel[] {
  // Display contract: only bettable, non-resolved signals are eligible for
  // Top Live Opportunities. Watch-only signals (incl. low-probability or
  // tier="watch") are explicitly excluded — they belong on the Watch row.
  return signals
    .filter(s => s.isBettable && s.actionable && !s.alreadyHit && s.liveScore > 0)
    .sort((a, b) => b.liveScore - a.liveScore)
    .slice(0, 5);
}

export function resolveTeamSide(
  teamAbbr: string,
  gameId: string,
  games: Array<{ gameId: string; homeAbbr: string | null }>
): "home" | "away" {
  const game = games.find(g => g.gameId === gameId);
  if (!game) return "home";
  return teamAbbr === game.homeAbbr ? "home" : "away";
}

export function buildCalcHydration(
  source: {
    playerId: string;
    playerName: string;
    teamAbbr: string;
    gameId: string;
    market: string;
    sportsbook?: string | null;
    line?: number | null;
  },
  games: Array<{ gameId: string; homeAbbr: string | null }>
): CalcHydrationPayload {
  return {
    gameId: source.gameId,
    playerId: source.playerId,
    playerName: source.playerName,
    teamAbbr: source.teamAbbr,
    teamSide: resolveTeamSide(source.teamAbbr, source.gameId, games),
    market: normalizeMarket(source.market),
    sportsbook: source.sportsbook ?? null,
    line: source.line ?? null,
  };
}
