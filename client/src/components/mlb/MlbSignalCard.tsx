import { useState } from "react";
import { ChevronDown, ChevronUp, Plus, X } from "lucide-react";
import {
  formatMlbMarketLabel,
  formatAmericanOdds,
  getMlbLiveStatValue,
  TIER_COLORS,
  SIDE_STYLES,
  generateShareTweet,
  openShareWindow,
} from "@/lib/mlbFormatters";
import type { MLBSignal } from "@shared/mlbSignal";

export type MlbSignalData = MLBSignal;

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
  pitcherSuppression: "Stuff Rating",
  pitcherDeterioration: "Fatigue Level",
  bullpenFactor: "Bullpen Factor",
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
}: {
  sig: MlbSignalData;
  onPlayerClick?: (gameId: string, playerId: string) => void;
  onAddToSlip?: (sig: MlbSignalData) => void;
  onDismiss?: (sig: MlbSignalData) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const tier = TIER_COLORS[sig.confidenceTier ?? "WATCHLIST"] ?? TIER_COLORS.WATCHLIST;
  const side = SIDE_STYLES[sig.recommendedSide as keyof typeof SIDE_STYLES] ?? SIDE_STYLES.OVER;
  const marketLabel = formatMlbMarketLabel(sig.market);
  const matchup = sig.awayAbbr && sig.homeAbbr ? `${sig.awayAbbr} @ ${sig.homeAbbr}` : null;
  const sideOdds = sig.recommendedSide === "OVER" ? sig.overOdds : sig.underOdds;
  const liveStat = getMlbLiveStatValue(sig);
  const cardOpacity = sig.stale ? 0.5 : sig.alreadyHit ? 0.75 : 1;
  const isClickable = !!(onPlayerClick && sig.gameId);
  const stability = stabilityGrade(sig.signalScore);

  const detectionLabel = `${sig.recommendedSide} ${sig.bookLine ?? ""} ${marketLabel}`.trim();

  const smartTags = sig.smartTags ?? [];
  const primaryReason = sig.primaryReason ?? "";

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

  return (
    <div
      data-testid={`mlb-signal-${sig.playerId}-${sig.market}`}
      className="rounded-xl border border-border/40 bg-card transition-all"
      style={{
        opacity: cardOpacity,
        borderLeft: `3px solid ${tier.border}`,
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
            <span
              className="text-[10px] font-black px-2.5 py-0.5 rounded-full shrink-0"
              style={{ background: tier.bg, color: tier.text, border: `1px solid ${tier.border}` }}
              data-testid={`badge-tier-${sig.playerId}-${sig.market}`}
            >
              {tier.badge}
            </span>
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
          <div className="flex flex-col items-end shrink-0">
            <span className="text-xl font-black tabular-nums leading-none" style={{ color: side.accent }}>
              {sig.enginePct.toFixed(0)}%
            </span>
            {matchup && <span className="text-[9px] text-muted-foreground mt-0.5">{matchup}</span>}
          </div>
        </div>

        {/* Row 2: Smart Tags (max 3) */}
        {smartTags.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
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

        {/* Row 3: Primary Reason (1 sentence) */}
        {primaryReason && (
          <p className="text-[10px] text-muted-foreground leading-snug italic">
            {primaryReason}
          </p>
        )}

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
      </div>

      {/* ── EXPANDED: Explainability Grid ── */}
      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-border/20 pt-2 animate-in slide-in-from-top-1 duration-200" onClick={(e) => e.stopPropagation()}>
          {/* Core Metrics Grid */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
            {sig.projection != null && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Projection</span>
                <span className="font-semibold text-foreground">{sig.projection.toFixed(2)}</span>
              </div>
            )}
            {sig.bookLine != null && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Need</span>
                <span className="font-semibold text-foreground">{sig.recommendedSide === "OVER" ? `≥ ${sig.bookLine + 0.5}` : `≤ ${sig.bookLine - 0.5}`}</span>
              </div>
            )}
            {sig.edge != null && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Edge</span>
                <span className="font-bold" style={{ color: sig.edge > 0 ? "#22c55e" : "#ef4444" }}>
                  {sig.edge > 0 ? "+" : ""}{sig.edge.toFixed(1)}%
                </span>
              </div>
            )}
            {sig.signalScore > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Signal Score</span>
                <span className="font-semibold text-foreground">{sig.signalScore}</span>
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
                      {ab.launchAngle != null && (
                        <span className="text-[7px] text-muted-foreground">
                          {ab.launchAngle.toFixed(0)}°
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
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

          {/* Pitcher Arsenal with Color Coding */}
          {sig.pitchMix && sig.pitchMix.length > 0 && (
            <div className="rounded-lg p-2.5 bg-secondary/20 border border-border/20 space-y-1.5">
              <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                {sig.pitcherName ? `${sig.pitcherName} Arsenal` : "Pitcher Arsenal"}
                {!isPitcherMarket && <span className="font-normal ml-1 text-muted-foreground/60">vs Batter</span>}
              </div>
              <div className="flex flex-wrap gap-1">
                {sig.pitchMix.slice(0, 5).map((p, i) => {
                  const rating = sig.pitchMatchupRatings?.[p.pitchType] ?? "neutral";
                  const borderColor = rating === "strong"
                    ? "rgba(34,197,94,0.6)"
                    : rating === "weak"
                    ? "rgba(239,68,68,0.5)"
                    : "rgba(148,163,184,0.3)";
                  const bgColor = rating === "strong"
                    ? "rgba(34,197,94,0.08)"
                    : rating === "weak"
                    ? "rgba(239,68,68,0.06)"
                    : "transparent";
                  const textColor = rating === "strong"
                    ? "#bbf7d0"
                    : rating === "weak"
                    ? "#fecaca"
                    : "#e4e4e7";
                  return (
                    <span
                      key={i}
                      className="text-[9px] px-2 py-1 rounded-md border flex items-center gap-1"
                      style={{ borderColor, color: textColor, background: bgColor }}
                      data-testid={`pitch-${p.pitchType}-${rating}`}
                    >
                      {rating === "strong" && <span className="text-[8px] text-green-400">▲</span>}
                      {rating === "weak" && <span className="text-[8px] text-red-400">▼</span>}
                      <span className="font-semibold">{PITCH_LABELS[p.pitchType] ?? p.pitchType}</span>
                      <span className="opacity-70">{Math.round(p.percentage)}%</span>
                      {p.avgVelocity != null && <span className="opacity-50">{p.avgVelocity.toFixed(0)}mph</span>}
                    </span>
                  );
                })}
              </div>
              {!isPitcherMarket && sig.pitchMatchupRatings && (
                <div className="flex items-center gap-3 text-[8px] text-muted-foreground/60 mt-0.5">
                  <span className="flex items-center gap-0.5"><span className="text-green-400">▲</span> batter advantage</span>
                  <span className="flex items-center gap-0.5"><span className="text-red-400">▼</span> pitcher advantage</span>
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
              {sig.riskFlags.map((f) => (
                <span key={f} className="text-[8px] px-1.5 py-0.5 rounded-full font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                  {f}
                </span>
              ))}
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
          {onAddToSlip && (
            <button
              data-testid={`button-slip-${sig.playerId}-${sig.market}`}
              className="text-[9px] px-2.5 py-1.5 rounded-lg font-semibold transition-colors flex items-center gap-0.5 min-h-[36px]"
              style={{ background: "rgba(34,197,94,0.15)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.3)" }}
              onClick={() => onAddToSlip(sig)}
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
