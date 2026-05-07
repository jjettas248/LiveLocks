import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Plus, X, Calculator } from "lucide-react";
import {
  formatMlbMarketLabel,
  formatAmericanOdds,
  getMlbLiveStatValue,
  TIER_COLORS,
  TIER_COLORS_BY_SIGNAL_TIER,
  resolveMlbSignalTier,
  SIDE_STYLES,
  MODE_STYLES,
  generateShareTweet,
  openShareWindow,
} from "@/lib/mlbFormatters";
import { liveScoreToGrade, launchAngleLabel, sanitizeDisplayString } from "@/lib/mlbUiMappers";
import { normalizePct } from "@/lib/mlb/mlbViewModel";
import { readCanonicalLifecycle, LIFECYCLE_BADGE } from "@/lib/mlb/canonicalSignalViewModel";
import type { MLBSignal } from "@shared/mlbSignal";

export type MlbSignalData = MLBSignal;

const BATTER_OVER_MARKETS_CARD = ["hits", "total_bases", "home_runs", "hrr", "batter_strikeouts"];

const BATTER_DRIVER_LABELS: Record<string, string> = {
  contactQuality: "Contact Quality",
  batSpeedPower: "Power Profile",
  handednessMatchup: "Platoon Edge",
  pitchBlendMatchup: "Pitch Matchup",
  hotColdForm: "Recent Form",
  parkEnv: "Park & Weather",
  bvp: "vs This Pitcher",
  lineupOpportunity: "Lineup Spot",
};

const PITCHER_DRIVER_LABELS: Record<string, string> = {
  pitcherSuppression: "Pitcher Quality",
  pitcherDeterioration: "TTO Advantage",
  bullpenFactor: "Late Game",
  hotColdForm: "Recent Form",
  parkEnv: "Park & Weather",
};

const PITCH_LABELS: Record<string, string> = {
  FF: "4-Seam", SI: "Sinker", FC: "Cutter", SL: "Slider",
  CU: "Curve", CH: "Change", FS: "Splitter", KC: "Knuckle Curve",
  KN: "Knuckle", EP: "Eephus", ST: "Sweeper", SV: "Slurve",
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

const HR_FACTOR_LABELS: Record<string, string> = {
  barrel_contact: "Barrel Contact",
  high_ev: "High Exit Velo",
  deep_flyout: "Deep Flyball",
  hard_hit: "Hard Hit",
  sweet_spot: "Sweet Spot Angle",
  park_boost: "Park Factor",
  wind_boost: "Wind Favorable",
  fatigue_boost: "Pitcher Fatigue",
  platoon_boost: "Platoon Edge",
  bat_speed: "Bat Speed",
  topEV: "Elite Exit Velo",
  topDistance: "Deep Flyball",
  topBarrel: "Barrel Machine",
  topHardHit: "Hard Contact Leader",
};

function driverBar(val: number): { color: string; label: string } {
  if (val >= 0.7) return { color: "#22c55e", label: "Strong" };
  if (val >= 0.55) return { color: "#a3e635", label: "Positive" };
  if (val >= 0.45) return { color: "#94a3b8", label: "Neutral" };
  if (val >= 0.35) return { color: "#f59e0b", label: "Weak" };
  return { color: "#ef4444", label: "Negative" };
}

function stabilityGrade(score: number | null | undefined): { grade: string; color: string } | null {
  if (score == null) return null;
  if (score >= 80) return { grade: "A+", color: "#22c55e" };
  if (score >= 70) return { grade: "A", color: "#22c55e" };
  if (score >= 60) return { grade: "B+", color: "#a3e635" };
  if (score >= 50) return { grade: "B", color: "#a3e635" };
  if (score >= 40) return { grade: "C+", color: "#f59e0b" };
  return { grade: "C", color: "#ef4444" };
}

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

export function MlbSignalCard({
  sig,
  onPlayerClick,
  onAddToSlip,
  onDismiss,
  onOpenCalculator,
}: {
  sig: MlbSignalData;
  onPlayerClick?: (gameId: string, playerId: string) => void;
  onAddToSlip?: (sig: MlbSignalData) => void;
  onDismiss?: (sig: MlbSignalData) => void;
  onOpenCalculator?: (sig: MlbSignalData) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // MLB Signals audit P6 — freshness pulse. The "as of N seconds ago" stamp
  // and the decay bar both depend on `Date.now()`, so we tick a 1Hz local
  // clock to drive re-renders. This is purely a renderer — no client-side
  // state ever flows back into the engine.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick(t => (t + 1) % 1_000_000), 1_000);
    return () => clearInterval(id);
  }, []);

  // [MLB Canonical Signal Tier — Phase 2] Prefer the server-stamped lowercase
  // `signalTier` ("watch" | "lean" | "strong" | "elite") so the badge matches
  // what LiveBoard buckets the signal under and what topPlaysService surfaces
  // elsewhere. Falls back to the legacy uppercase confidenceTier color map
  // only when signalTier is missing (cache rollover) — resolveMlbSignalTier
  // emits [MLB_TIER_FALLBACK] in that path.
  const canonicalTier = resolveMlbSignalTier(sig as any);
  const tier = TIER_COLORS_BY_SIGNAL_TIER[canonicalTier] ?? TIER_COLORS[sig.confidenceTier ?? "WATCHLIST"] ?? TIER_COLORS.WATCHLIST;
  // [LiveLocks Batch D] Canonical lifecycle badge — read directly from the
  // server-stamped canonicalLifecycleState (NEVER inferred from probability).
  const canonicalLifecycle = readCanonicalLifecycle(sig as any);
  const lifecycleBadge = LIFECYCLE_BADGE[canonicalLifecycle];
  const side = SIDE_STYLES[sig.recommendedSide as keyof typeof SIDE_STYLES] ?? SIDE_STYLES.OVER;
  const marketLabel = formatMlbMarketLabel(sig.market);
  const matchup = sig.awayAbbr && sig.homeAbbr ? `${sig.awayAbbr} @ ${sig.homeAbbr}` : null;
  const sideOdds = sig.recommendedSide === "OVER" ? sig.overOdds : sig.underOdds;
  const liveStat = getMlbLiveStatValue(sig);
  // MLB Signals audit P6 — engine-state-driven dimming. Once the engine
  // marks a non-HR signal CLOSED (resolved or game-final) the card is fully
  // hidden visually; the route's bettable-feed filter strips it from the
  // list, but the dim is belt-and-suspenders for any caller that still
  // renders the raw signal.
  const isEngineClosed = sig.engineState === "CLOSED";
  const cardOpacity = isEngineClosed
    ? 0.35
    : sig.stale
      ? 0.5
      : sig.alreadyHit
        ? 0.75
        : 1;
  const isClickable = !!(onPlayerClick && sig.gameId);
  const stability = stabilityGrade(sig.signalScore);

  const detectionLabel = `${sig.recommendedSide} ${sig.bookLine ?? ""} ${marketLabel}`.trim();

  const smartTags = (sig.smartTags ?? []).map(t => sanitizeDisplayString(t)).filter(t => t.length >= 3);
  const primaryReason = sig.primaryReason ? sanitizeDisplayString(sig.primaryReason) : "";

  const isPitcherMarket = sig.market.startsWith("pitcher_") || sig.market === "hits_allowed" || sig.market === "walks_allowed" || sig.market === "hr_allowed";
  const driverLabels = isPitcherMarket ? PITCHER_DRIVER_LABELS : BATTER_DRIVER_LABELS;
  const drivers = sig.drivers ?? {};
  const activeDrivers = Object.entries(drivers)
    .filter(([k]) => driverLabels[k])
    .sort(([, a], [, b]) => Math.abs(b - 0.5) - Math.abs(a - 0.5));

  const visibleBadges = (sig.badges ?? [])
    .map(b => BADGE_DISPLAY[b])
    .filter((b): b is { label: string; color: string } => b != null)
    .slice(0, 3);

  const priorABs = sig.priorABResults ?? [];

  const isHRMarket = sig.market === "home_runs" || sig.market === "hrr";
  const hrIntensity = sig.hrIntensity;
  const hrBuild = sig.hrFactors?.build as {
    avgEV: number | null; maxEV: number | null; avgLA: number | null;
    barrels: number; hardHits: number; deepFlyouts: number;
  } | undefined;

  const intensityStyle: Record<string, { border: string; glow: string; bg: string; badge: string; text: string }> = {
    weak: { border: "#6b7280", glow: "none", bg: "transparent", badge: "TRACKING", text: "#9ca3af" },
    watch: { border: "#eab308", glow: "0 0 8px rgba(234,179,8,0.3)", bg: "rgba(234,179,8,0.04)", badge: "WATCH", text: "#facc15" },
    strong: { border: "#f97316", glow: "0 0 12px rgba(249,115,22,0.4)", bg: "rgba(249,115,22,0.06)", badge: "RISING", text: "#fb923c" },
    imminent: { border: "#ef4444", glow: "0 0 18px rgba(239,68,68,0.5)", bg: "rgba(239,68,68,0.08)", badge: "IMMINENT", text: "#f87171" },
  };
  const hrStyle = isHRMarket && hrIntensity ? intensityStyle[hrIntensity] : null;

  const modeStyle = sig.mode ? MODE_STYLES[sig.mode] ?? null : null;
  const isHRMode = sig.mode?.startsWith("hr_") ?? false;
  const cardBorder = modeStyle ? modeStyle.border : (hrStyle?.border ?? tier.border);
  const cardGlow = isHRMode && modeStyle ? `0 0 12px ${modeStyle.border}` : (hrStyle?.glow ?? "none");
  const cardBg = modeStyle ? modeStyle.bg : (hrStyle?.bg ?? undefined);

  return (
    <div
      data-testid={`mlb-signal-${sig.playerId}-${sig.market}`}
      className={`rounded-xl border border-border/40 bg-card transition-all ${(isHRMarket && hrIntensity === "imminent") || sig.mode === "hr_elite" ? "animate-pulse" : ""}`}
      style={{
        opacity: cardOpacity,
        borderLeft: `3px solid ${cardBorder}`,
        boxShadow: cardGlow,
        background: cardBg,
      }}
    >
      {/* ── COLLAPSED: 3-Second Decision Layer ── */}
      <div
        className="p-3 space-y-1.5 cursor-pointer"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded(!expanded); } }}
      >
        {/* Row 1: Tier badge + Detection + Probability */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {modeStyle ? (
              <span
                className="text-[10px] font-black px-2.5 py-0.5 rounded-full shrink-0"
                style={{ background: modeStyle.bg, color: modeStyle.color, border: `1px solid ${modeStyle.border}` }}
                data-testid={`badge-mode-${sig.playerId}-${sig.market}`}
              >
                {modeStyle.icon} {modeStyle.label}
              </span>
            ) : (
              <span
                className="text-[10px] font-black px-2.5 py-0.5 rounded-full shrink-0"
                style={{ background: tier.bg, color: tier.text, border: `1px solid ${tier.border}` }}
                data-testid={`badge-tier-${sig.playerId}-${sig.market}`}
              >
                {tier.badge}
              </span>
            )}
            {canonicalLifecycle !== "unknown" && (
              <span
                className="text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0"
                style={{ background: lifecycleBadge.bg, color: lifecycleBadge.text }}
                data-testid={`badge-lifecycle-${sig.playerId}-${sig.market}`}
                title={`Lifecycle state: ${canonicalLifecycle}`}
              >
                {lifecycleBadge.label}
              </span>
            )}
            <div className="min-w-0">
              {isClickable ? (
                <span
                  className="text-xs font-bold text-foreground truncate block hover:underline cursor-pointer"
                  data-testid={`link-player-${sig.playerId}`}
                  onClick={(e) => { e.stopPropagation(); onPlayerClick!(sig.gameId!, sig.playerId); }}
                  role="link"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onPlayerClick!(sig.gameId!, sig.playerId); } }}
                >{sig.playerName}</span>
              ) : (
                <span className="text-xs font-bold text-foreground truncate block">{sig.playerName}</span>
              )}
              <p className="text-[11px] font-bold tracking-tight" style={{ color: side.accent }}>
                {detectionLabel}
                {sideOdds != null && <span className="ml-1 text-muted-foreground font-normal text-[10px]">({formatAmericanOdds(sideOdds)})</span>}
              </p>
            </div>
          </div>
          <div
            className="flex flex-col items-end shrink-0"
            title={`Engine win probability — model's estimated chance ${sig.recommendedSide} ${sig.bookLine ?? ""} ${marketLabel} hits. Higher = stronger conviction.`}
            data-testid={`engine-prob-${sig.playerId}-${sig.market}`}
          >
            {/* [MLB Canonical Probability v1] sig.enginePct is the recommended-
                side calibrated probability emitted by the MLB engine. The UI
                does no math on it — pure renderer. */}
            <span className="text-xl font-black tabular-nums leading-none" style={{ color: side.accent }}>
              {normalizePct(sig.enginePct).toFixed(0)}%
            </span>
            <span className="text-[9px] text-muted-foreground mt-0.5 uppercase tracking-wide font-semibold">
              win prob
            </span>
            {matchup && <span className="text-[9px] text-muted-foreground/80">{matchup}</span>}
          </div>
        </div>

        {/* Row 2: Smart Tags + HR Intensity Badge + Pitcher Signals */}
        {(smartTags.length > 0 || hrStyle || (sig.pitcherSignals && sig.pitcherSignals.length > 0) || (sig.liveScore ?? 0) > 0) && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {hrStyle && (
              <span
                data-testid={`hr-intensity-${sig.playerId}`}
                className="text-[10px] px-2 py-0.5 rounded-full font-black border"
                style={{
                  color: hrStyle.text,
                  borderColor: `${hrStyle.border}66`,
                  background: `${hrStyle.border}20`,
                }}
              >
                ⚡ {hrStyle.badge}
              </span>
            )}
            {sig.pitcherSignals && sig.pitcherSignals.length > 0 && sig.pitcherSignals.slice(0, 2).map(ps => {
              const PSIG: Record<string, { label: string; color: string }> = {
                DOMINANT: { label: "Dominant", color: "#ef4444" },
                K_STREAK: { label: "K Streak", color: "#f59e0b" },
                COMMAND_LOCKED: { label: "Locked In", color: "#22c55e" },
                VELOCITY_DROP: { label: "Velo Drop", color: "#f97316" },
                FATIGUE_RISK: { label: "Fatigued", color: "#f97316" },
                HARD_CONTACT: { label: "Hard Hit", color: "#ef4444" },
              };
              const display = PSIG[ps];
              if (!display) return null;
              return (
                <span
                  key={ps}
                  data-testid={`pitcher-sig-${ps}`}
                  className="text-[9px] font-black px-1.5 py-0.5 rounded-full border"
                  style={{ color: display.color, borderColor: `${display.color}40`, background: `${display.color}10` }}
                >
                  {display.label}
                </span>
              );
            })}
            {(sig.feedTags ?? []).some(t => t === "inning_3" || t === "inning_5" || t === "inning_7") && (() => {
              const INNING_BADGE: Record<string, { label: string; color: string; priority: number }> = {
                inning_7: { label: "7th Inn Edge", color: "#ef4444", priority: 3 },
                inning_5: { label: "5th Inn Edge", color: "#f59e0b", priority: 2 },
                inning_3: { label: "3rd Inn Edge", color: "#a78bfa", priority: 1 },
              };
              const tags = (sig.feedTags ?? []).filter(t => INNING_BADGE[t]);
              if (tags.length === 0) return null;
              const tag = tags.sort((a, b) => INNING_BADGE[b].priority - INNING_BADGE[a].priority)[0];
              const badge = INNING_BADGE[tag];
              return (
                <span
                  data-testid={`inning-badge-${tag}`}
                  className="text-[9px] font-black px-1.5 py-0.5 rounded-full border"
                  style={{ color: badge.color, borderColor: `${badge.color}40`, background: `${badge.color}10` }}
                >
                  {badge.label}
                </span>
              );
            })()}
            {(sig.liveScore ?? 0) >= 0.04 && (() => {
              const lsGrade = liveScoreToGrade(sig.liveScore ?? 0);
              return (
                <span
                  data-testid={`live-score-${sig.playerId}-${sig.market}`}
                  className="text-[9px] font-bold px-1.5 py-0.5 rounded-full border"
                  style={{
                    color: lsGrade.color,
                    borderColor: `${lsGrade.color}40`,
                    background: `${lsGrade.color}10`,
                  }}
                >
                  Live {lsGrade.grade}
                </span>
              );
            })()}
            {smartTags.map((tag) => (
              <span
                key={tag}
                className="text-[10px] px-2 py-0.5 rounded-full font-semibold"
                style={{ background: "rgba(255,255,255,0.06)", color: "#e4e4e7" }}
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Phase E: engine mode pills — distinguish strict/fallback/watch
             so users know whether a signal cleared the strict threshold or
             came through the fallback path. Pure renderer of engine fields:
               - sig.fallbackUsed → fallback pill
               - sig.isEarlySignal → "Pre-AB Watch" pill (when no mode pill)
               - sig.watchlist (non-early) → "Watch" pill (when no mode pill)
             Mode pill in Row 1 already covers strict tiers (Elite/Strong/etc).
        */}
        {(sig.fallbackUsed || sig.isEarlySignal || (sig.watchlist && !sig.fallbackUsed && !modeStyle)) && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {sig.fallbackUsed && (
              <span
                data-testid={`badge-fallback-${sig.playerId}-${sig.market}`}
                className="text-[9px] font-bold px-2 py-0.5 rounded-full border"
                style={{
                  color: "#fbbf24",
                  borderColor: "rgba(251,191,36,0.4)",
                  background: "rgba(251,191,36,0.08)",
                }}
                title="Fallback mode — engine surfaced this signal under relaxed criteria. Treat conviction as lower than strict signals."
              >
                Fallback
              </span>
            )}
            {sig.isEarlySignal && (
              <span
                data-testid={`badge-pre-ab-watch-${sig.playerId}-${sig.market}`}
                className="text-[9px] font-bold px-2 py-0.5 rounded-full border"
                style={{
                  color: "#a78bfa",
                  borderColor: "rgba(167,139,250,0.4)",
                  background: "rgba(167,139,250,0.08)",
                }}
                title="Pre-AB Watch — early-game signal flagged for monitoring before the engine has full plate-appearance data."
              >
                Pre-AB Watch
              </span>
            )}
            {sig.watchlist && !sig.isEarlySignal && !modeStyle && (
              <span
                data-testid={`badge-watch-${sig.playerId}-${sig.market}`}
                className="text-[9px] font-bold px-2 py-0.5 rounded-full border"
                style={{
                  color: "#94a3b8",
                  borderColor: "rgba(148,163,184,0.4)",
                  background: "rgba(148,163,184,0.08)",
                }}
                title="Watchlist — monitor only, not actionable at the strict-engine threshold."
              >
                Watch
              </span>
            )}
          </div>
        )}

        {/* Row 3: Why now — readable drivers (Phase D) when present, else
             fall back to the engine-generated primary reason. */}
        {sig.diagnostics?.readableDrivers && sig.diagnostics.readableDrivers.length > 0 ? (
          <ul
            className="text-[10px] text-muted-foreground leading-snug list-none space-y-0.5"
            data-testid={`readable-drivers-${sig.playerId}-${sig.market}`}
          >
            {sig.diagnostics.readableDrivers.slice(0, 3).map((line, i) => (
              <li key={i} className="flex items-start gap-1">
                <span className="text-primary/60 shrink-0">•</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        ) : primaryReason ? (
          <p className="text-[10px] text-muted-foreground leading-snug italic">
            {primaryReason}
          </p>
        ) : null}

        {/* Row 4: Compact status pills */}
        <div className="flex items-center gap-2 text-[9px]">
          {liveStat ? (
            <span className="text-muted-foreground">
              {liveStat.label}: <span className="font-semibold" style={{ color: liveStat.value >= (sig.bookLine ?? 99) ? "#22c55e" : "#ffffff" }}>
                {liveStat.value}/{sig.bookLine}
              </span>
            </span>
          ) : null}
          {sig.alreadyHit && (
            <span className="font-black px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
              HIT ✓
            </span>
          )}
          {sig.inning > 0 && (
            <span className="text-muted-foreground">Inn {sig.inning}</span>
          )}
          {stability && (
            <span className="font-bold ml-auto" style={{ color: stability.color }}>
              {stability.grade}
            </span>
          )}
        </div>

        {/* ── MLB Signals audit P6 — Engine freshness pulse + decay rail ──
             Renders strictly from engine-supplied fields:
               - sig.engineState        (BUILDING|ACTIVE|COOLING|CLOSED)
               - sig.engineStateChangedAt
               - sig.decayFactor        (0..1)
               - sig.signalTimestamp    (engine tick time)
             Engine-as-truth: no derived behavior — purely a renderer. */}
        {sig.engineState != null && (() => {
          const stateColor =
            sig.engineState === "ACTIVE"   ? "#22c55e" :
            sig.engineState === "COOLING"  ? "#f59e0b" :
            sig.engineState === "CLOSED"   ? "#6b7280" :
                                              "#3b82f6"; // BUILDING
          const decay = typeof sig.decayFactor === "number" ? sig.decayFactor : 1;
          const decayPct = Math.max(0, Math.min(1, decay)) * 100;
          const decayColor = decay >= 0.75 ? "#22c55e" : decay >= 0.5 ? "#a3e635" : decay >= 0.25 ? "#f59e0b" : "#ef4444";
          const tickAge = sig.signalTimestamp ? Math.max(0, Math.floor((Date.now() - sig.signalTimestamp) / 1000)) : null;
          const tickAgeLabel = tickAge == null
            ? "—"
            : tickAge < 60
              ? `${tickAge}s ago`
              : `${Math.floor(tickAge / 60)}m ${tickAge % 60}s ago`;
          const ageColor = tickAge != null && tickAge > 60 ? "#ef4444" : tickAge != null && tickAge > 30 ? "#f59e0b" : "#9ca3af";
          const pulseClass = sig.engineState === "ACTIVE" ? "animate-pulse" : "";
          return (
            <div
              className="flex items-center gap-2 text-[9px] pt-1"
              data-testid={`engine-freshness-${sig.playerId}-${sig.market}`}
            >
              <span
                className={`inline-block w-1.5 h-1.5 rounded-full ${pulseClass}`}
                style={{ background: stateColor }}
                aria-hidden="true"
              />
              <span className="font-semibold uppercase tracking-wide" style={{ color: stateColor }} data-testid={`engine-state-${sig.playerId}-${sig.market}`}>
                {sig.engineState}
              </span>
              <span className="flex-1 h-1 rounded-full bg-muted/40 overflow-hidden" title={`Engine decay rail: ${decayPct.toFixed(0)}% of peak`}>
                <span
                  className="block h-full transition-all duration-500"
                  style={{ width: `${decayPct}%`, background: decayColor }}
                  data-testid={`engine-decay-${sig.playerId}-${sig.market}`}
                />
              </span>
              <span className="tabular-nums" style={{ color: ageColor }} data-testid={`engine-tick-age-${sig.playerId}-${sig.market}`}>
                {tickAgeLabel}
              </span>
            </div>
          );
        })()}
      </div>

      {/* ── EXPANDED: Explainability Grid ── */}
      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-border/20 pt-2 animate-in slide-in-from-top-1 duration-200" onClick={(e) => e.stopPropagation()}>
          {/* Core Metrics Grid */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
            {sig.bookLine != null && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Need</span>
                <span className="font-semibold text-foreground">{sig.recommendedSide === "OVER" ? `≥ ${sig.bookLine + 0.5}` : `≤ ${sig.bookLine - 0.5}`}</span>
              </div>
            )}
            {BATTER_OVER_MARKETS_CARD.includes(sig.market) ? (
              sig.signalScore != null && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Signal</span>
                  <span className="font-bold" style={{ color: sig.signalScore >= 68 ? "#22c55e" : sig.signalScore >= 42 ? "#eab308" : "#71717a" }}>
                    {sig.signalScore}
                  </span>
                </div>
              )
            ) : (
              sig.edge != null && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Edge</span>
                  <span className="font-bold" style={{ color: sig.edge > 0 ? "#22c55e" : "#ef4444" }}>
                    {sig.edge > 0 ? "+" : ""}{sig.edge.toFixed(1)}%
                  </span>
                </div>
              )
            )}
            {stability && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Confidence</span>
                <span className="font-bold" style={{ color: stability.color }}>{stability.grade}</span>
              </div>
            )}
          </div>

          {/* Today's Stats */}
          {sig.currentStats && (() => {
            const cs = sig.currentStats;
            return (
              <div className="flex items-center gap-2 py-1.5 px-2.5 rounded-lg bg-secondary/30 border border-border/20 text-[10px]">
                <span className="text-muted-foreground font-semibold uppercase text-[9px] shrink-0">Today</span>
                <div className="flex items-center gap-2 flex-wrap">
                  {(cs.ab ?? 0) > 0 && <span className="text-foreground font-semibold">{cs.h ?? 0}-{cs.ab}</span>}
                  {(cs.hr ?? 0) > 0 && <span className="text-orange-400 font-bold">{cs.hr} HR</span>}
                  {(cs.tb ?? 0) > 0 && <span className="text-muted-foreground">{cs.tb} TB</span>}
                  {(cs.rbi ?? 0) > 0 && <span className="text-muted-foreground">{cs.rbi} RBI</span>}
                  {(cs.bb ?? 0) > 0 && <span className="text-muted-foreground">{cs.bb} BB</span>}
                  {(cs.k ?? 0) > 0 && <span className="text-red-400">{cs.k} K</span>}
                </div>
              </div>
            );
          })()}

          {/* Prior At-Bats Log */}
          {priorABs.length > 0 && (
            <div className="rounded-lg p-2.5 bg-secondary/20 border border-border/20">
              <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">
                Plate Appearances ({priorABs.length})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {priorABs.map((ab, i) => {
                  const style = AB_OUTCOME_STYLE[ab.outcome] ?? { label: ab.outcome?.slice(0, 3) ?? "?", color: "#6b7280" };
                  return (
                    <div
                      key={i}
                      className="flex flex-col items-center px-1.5 py-1 rounded bg-secondary/40 border border-border/20 min-w-[32px]"
                    >
                      <span className="text-[9px] font-bold" style={{ color: style.color }}>
                        {style.label}
                      </span>
                      {ab.exitVelocity != null && (
                        <span className="text-[7px] text-muted-foreground mt-0.5">
                          {ab.exitVelocity.toFixed(0)}mph
                        </span>
                      )}
                      {ab.launchAngle != null && (() => {
                        const la = Math.round(ab.launchAngle);
                        const laLabel = launchAngleLabel(ab.launchAngle);
                        return (
                          <span className="text-[7px] text-muted-foreground">
                            {la}° <span className={laLabel.color}>{laLabel.tag}</span>
                          </span>
                        );
                      })()}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* HR Build Factors */}
          {isHRMarket && hrBuild && hrStyle && (
            <div className="rounded-lg p-2.5 border border-border/20 space-y-1.5" style={{ background: `${hrStyle.border}08`, borderColor: `${hrStyle.border}30` }}>
              <div className="flex items-center justify-between">
                <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: hrStyle.text }}>
                  HR Radar Profile
                </span>
                <span className="text-[10px] font-black" style={{ color: hrStyle.text }}>
                  {hrStyle.badge}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-1.5 text-[9px]">
                {hrBuild.avgEV != null && (
                  <div className="flex flex-col items-center py-1 px-1.5 rounded bg-secondary/30">
                    <span className="text-muted-foreground text-[8px]">Avg EV</span>
                    <span className="font-bold" style={{ color: hrBuild.avgEV >= 95 ? "#f97316" : hrBuild.avgEV >= 90 ? "#a3e635" : "#e4e4e7" }}>
                      {hrBuild.avgEV.toFixed(1)}
                    </span>
                  </div>
                )}
                {hrBuild.maxEV != null && (
                  <div className="flex flex-col items-center py-1 px-1.5 rounded bg-secondary/30">
                    <span className="text-muted-foreground text-[8px]">Max EV</span>
                    <span className="font-bold" style={{ color: hrBuild.maxEV >= 105 ? "#ef4444" : hrBuild.maxEV >= 100 ? "#f97316" : "#e4e4e7" }}>
                      {hrBuild.maxEV.toFixed(1)}
                    </span>
                  </div>
                )}
                {hrBuild.avgLA != null && (
                  <div className="flex flex-col items-center py-1 px-1.5 rounded bg-secondary/30">
                    <span className="text-muted-foreground text-[8px]">Avg LA</span>
                    <span className="font-bold" style={{ color: hrBuild.avgLA >= 20 && hrBuild.avgLA <= 35 ? "#22c55e" : "#e4e4e7" }}>
                      {hrBuild.avgLA.toFixed(0)}°
                    </span>
                  </div>
                )}
                <div className="flex flex-col items-center py-1 px-1.5 rounded bg-secondary/30">
                  <span className="text-muted-foreground text-[8px]">Barrels</span>
                  <span className="font-bold" style={{ color: hrBuild.barrels > 0 ? "#f97316" : "#6b7280" }}>
                    {hrBuild.barrels}
                  </span>
                </div>
                <div className="flex flex-col items-center py-1 px-1.5 rounded bg-secondary/30">
                  <span className="text-muted-foreground text-[8px]">Hard Hits</span>
                  <span className="font-bold" style={{ color: hrBuild.hardHits > 0 ? "#22c55e" : "#6b7280" }}>
                    {hrBuild.hardHits}
                  </span>
                </div>
                {hrBuild.deepFlyouts > 0 && (
                  <div className="flex flex-col items-center py-1 px-1.5 rounded bg-secondary/30">
                    <span className="text-muted-foreground text-[8px]">Deep Flys</span>
                    <span className="font-bold text-amber-400">{hrBuild.deepFlyouts}</span>
                  </div>
                )}
              </div>
              {sig.hrFactors?.labels && (sig.hrFactors.labels as string[]).length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {(sig.hrFactors.labels as string[]).map((label: string) => {
                    const cleaned = HR_FACTOR_LABELS[label] ?? label.replace(/_/g, " ").replace(/[+:]/g, " ").replace(/\s+/g, " ").trim();
                    if (!cleaned || cleaned.length < 2) return null;
                    return (
                      <span key={label} className="text-[8px] px-1.5 py-0.5 rounded-full font-medium border" style={{ color: hrStyle.text, borderColor: `${hrStyle.border}40`, background: `${hrStyle.border}15` }}>
                        {cleaned}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Contact Quality */}
          {sig.lastABContact && (sig.lastABContact.exitVelo != null || sig.lastABContact.launchAngle != null) && (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] px-2.5 py-1.5 rounded-lg bg-secondary/20 border border-border/20">
              <div className="col-span-2 text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-0.5">Last AB Contact</div>
              {sig.lastABContact.exitVelo != null && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Exit Velo</span>
                  <span className="font-semibold" style={{ color: sig.lastABContact.exitVelo >= 95 ? "#f97316" : sig.lastABContact.exitVelo >= 90 ? "#a3e635" : "#e4e4e7" }}>
                    {sig.lastABContact.exitVelo.toFixed(1)} mph
                  </span>
                </div>
              )}
              {sig.lastABContact.launchAngle != null && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Launch Angle</span>
                  <span className="font-semibold" style={{
                    color: sig.lastABContact.launchAngle >= 15 && sig.lastABContact.launchAngle <= 30
                      ? "#22c55e" : "#e4e4e7"
                  }}>
                    {sig.lastABContact.launchAngle.toFixed(0)}°
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Phase D: Why now — full readable driver list (engine-built, no
               recompute). Shown above the numeric driver bars so the user
               sees the human story first, then the supporting metrics. */}
          {sig.diagnostics?.readableDrivers && sig.diagnostics.readableDrivers.length > 0 && (
            <div
              className="rounded-lg p-2.5 bg-secondary/20 border border-border/20"
              data-testid={`readable-drivers-expanded-${sig.playerId}-${sig.market}`}
            >
              <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">
                Why Now
              </div>
              <ul className="space-y-1 text-[10px] text-foreground/90 list-none">
                {sig.diagnostics.readableDrivers.map((line, i) => (
                  <li key={i} className="flex items-start gap-1.5 leading-snug">
                    <span className="text-primary/70 shrink-0 mt-0.5">•</span>
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Driver Scores */}
          {activeDrivers.length > 0 && (
            <div className="rounded-lg p-2.5 bg-secondary/20 border border-border/20">
              <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">
                {isPitcherMarket ? "Pitcher Analysis" : "Batter Analysis"}
              </div>
              <div className="space-y-1">
                {activeDrivers.slice(0, 6).map(([key, val]) => {
                  const d = driverBar(val);
                  return (
                    <div key={key} className="flex items-center justify-between gap-2">
                      <span className="text-[9px] text-muted-foreground truncate">{driverLabels[key]}</span>
                      <div className="flex items-center gap-1.5">
                        <div className="w-16 h-1.5 rounded-full bg-secondary/60 overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{ width: `${Math.round(val * 100)}%`, backgroundColor: d.color }}
                          />
                        </div>
                        <span className="text-[8px] font-bold tabular-nums w-5 text-right" style={{ color: d.color }}>
                          {(val * 100).toFixed(0)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Pitcher Arsenal with Bidirectional Color Coding */}
          {sig.pitchMix && sig.pitchMix.length > 0 && (
            <div className="rounded-lg p-2.5 bg-secondary/20 border border-border/20 space-y-1.5">
              <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                {sig.pitcherName ? `${sig.pitcherName} Arsenal` : "Pitcher Arsenal"}
                {!isPitcherMarket && <span className="font-normal ml-1 text-muted-foreground/60">vs Batter</span>}
              </div>
              <div className="flex flex-wrap gap-1">
                {sig.pitchMix.slice(0, 5).map((p, i) => {
                  // Server now emits explicit `favor` (always batter-relative). Drop the
                  // client-side isPitcherMarket flip — it caused inverted directionality.
                  const ratingEntry = sig.pitchMatchupRatings?.[p.pitchType];
                  const favor = (ratingEntry && typeof ratingEntry === "object" && "favor" in ratingEntry)
                    ? (ratingEntry as any).favor as "batter" | "pitcher" | "neutral"
                    : "neutral";
                  const isBatterFavor = favor === "batter";
                  const isPitcherFavor = favor === "pitcher";
                  const borderColor = isBatterFavor
                    ? "rgba(34,197,94,0.6)"
                    : isPitcherFavor
                    ? "rgba(239,68,68,0.5)"
                    : "rgba(148,163,184,0.3)";
                  const bgColor = isBatterFavor
                    ? "rgba(34,197,94,0.08)"
                    : isPitcherFavor
                    ? "rgba(239,68,68,0.06)"
                    : "transparent";
                  const textColor = isBatterFavor
                    ? "#bbf7d0"
                    : isPitcherFavor
                    ? "#fecaca"
                    : "#e4e4e7";
                  const favorLabel = isBatterFavor ? "Batter" : isPitcherFavor ? "Pitcher" : null;
                  return (
                    <span
                      key={i}
                      className="text-[9px] px-2 py-1 rounded-md border flex items-center gap-1"
                      style={{ borderColor, color: textColor, background: bgColor }}
                      data-testid={`pitch-${p.pitchType}-${isBatterFavor ? "batter-favor" : isPitcherFavor ? "pitcher-favor" : "neutral"}`}
                    >
                      {isBatterFavor && <span className="text-[8px] text-green-400">▲</span>}
                      {isPitcherFavor && <span className="text-[8px] text-red-400">▼</span>}
                      <span className="font-semibold">{(p as any).pitchName ?? PITCH_LABELS[p.pitchType] ?? p.pitchType}</span>
                      <span className="opacity-70">{Math.round(p.percentage)}%</span>
                      {p.avgVelocity != null && <span className="opacity-50">{p.avgVelocity.toFixed(0)}mph</span>}
                    </span>
                  );
                })}
              </div>
              {sig.pitchMatchupRatings && (
                <div className="flex items-center gap-3 text-[8px] text-muted-foreground/60 mt-0.5">
                  <span className="flex items-center gap-0.5"><span className="text-green-400">▲</span> batter favor</span>
                  <span className="flex items-center gap-0.5"><span className="text-red-400">▼</span> pitcher favor</span>
                </div>
              )}
            </div>
          )}

          {/* BvP */}
          {sig.bvp && sig.bvp.atBats > 0 && (
            <div className="text-[9px] px-2.5 py-1.5 rounded-lg bg-secondary/20 border border-border/20">
              <span className="text-muted-foreground/70">BvP: </span>
              <span className="text-foreground font-semibold">{sig.bvp.hits}/{sig.bvp.atBats}</span>
              <span className="text-muted-foreground/50 ml-1">({sig.bvp.avg != null ? sig.bvp.avg.toFixed(3) : "—"})</span>
              {sig.bvp.homeRuns > 0 && <span className="text-orange-400 ml-1.5 font-semibold">{sig.bvp.homeRuns} HR</span>}
            </div>
          )}

          {/* Badges (cleaned up labels) */}
          {visibleBadges.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {visibleBadges.map((b) => (
                <span
                  key={b.label}
                  className="text-[8px] px-1.5 py-0.5 rounded-full font-semibold border"
                  style={{ color: b.color, borderColor: `${b.color}33`, background: `${b.color}15` }}
                >
                  {b.label}
                </span>
              ))}
            </div>
          )}

          {/* Risk / Warning Flags */}
          {(sig.riskFlags.length > 0 || sig.isDegraded || sig.safetyCeilingApplied) && (
            <div className="flex flex-wrap gap-1">
              {sig.isDegraded && (
                <span className="text-[8px] px-1.5 py-0.5 rounded-full font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                  Limited Data
                </span>
              )}
              {sig.safetyCeilingApplied && (
                <span className="text-[8px] px-1.5 py-0.5 rounded-full font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                  Ceiling Applied
                </span>
              )}
              {sig.riskFlags.map((f) => {
                const label = sanitizeDisplayString(f);
                if (label.length < 3) return null;
                return (
                  <span key={f} className="text-[8px] px-1.5 py-0.5 rounded-full font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                    {label}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Action Bar ── */}
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-border/20" onClick={(e) => e.stopPropagation()}>
        <button
          data-testid={`button-expand-${sig.playerId}-${sig.market}`}
          className="flex items-center gap-1 text-[9px] text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {expanded ? "Less" : "Details"}
        </button>
        <div className="flex items-center gap-1.5">
          {onDismiss && (
            <button
              data-testid={`button-dismiss-${sig.playerId}-${sig.market}`}
              className="text-[9px] p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
              onClick={() => onDismiss(sig)}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          {onOpenCalculator && (
            <button
              data-testid={`button-calc-${sig.playerId}-${sig.market}`}
              className="text-[9px] px-2.5 py-1.5 rounded-lg font-semibold transition-colors flex items-center gap-0.5 min-h-[36px]"
              style={{ background: "rgba(168,85,247,0.12)", color: "#c084fc", border: "1px solid rgba(168,85,247,0.3)" }}
              onClick={(e) => { e.stopPropagation(); onOpenCalculator(sig); }}
              title="Open in Calculator"
            >
              <Calculator className="w-3 h-3" /> Calc
            </button>
          )}
          {onAddToSlip && (
            <button
              data-testid={`button-slip-${sig.playerId}-${sig.market}`}
              className="text-[9px] px-2.5 py-1.5 rounded-lg font-semibold transition-colors flex items-center gap-0.5 min-h-[36px]"
              style={{ background: "rgba(34,197,94,0.15)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.3)" }}
              onClick={(e) => { e.stopPropagation(); onAddToSlip(sig); }}
            >
              <Plus className="w-3 h-3" /> Slip
            </button>
          )}
          <button
            data-testid={`button-share-${sig.playerId}-${sig.market}`}
            className="text-[9px] px-2.5 py-1.5 rounded-lg font-semibold transition-colors min-h-[36px]"
            style={{ background: "rgba(59,130,246,0.1)", color: "#60a5fa", border: "1px solid rgba(59,130,246,0.2)" }}
            onClick={() => openShareWindow(generateShareTweet(sig))}
          >𝕏</button>
          <button
            data-testid={`button-copy-${sig.playerId}-${sig.market}`}
            className="text-[9px] px-2 py-1.5 rounded-lg font-semibold transition-colors min-h-[36px] border border-border text-muted-foreground hover:text-foreground hover:bg-muted/40"
            onClick={() => {
              const text = generateShareTweet(sig);
              navigator.clipboard?.writeText(text).then(() => {
                const btn = document.querySelector(`[data-testid="button-copy-${sig.playerId}-${sig.market}"]`);
                if (btn) { btn.textContent = "✓"; setTimeout(() => { btn.textContent = "Copy"; }, 1500); }
              }).catch(() => {});
            }}
          >Copy</button>
        </div>
      </div>
    </div>
  );
}
