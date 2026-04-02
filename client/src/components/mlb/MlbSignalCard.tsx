import { useState } from "react";
import { ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import {
  formatMlbMarketLabel,
  formatAmericanOdds,
  getMlbLiveStatValue,
  formBadge,
  TIER_COLORS,
  SIDE_STYLES,
  generateShareTweet,
  openShareWindow,
} from "@/lib/mlbFormatters";
import type { MLBSignal } from "@shared/mlbSignal";

export type MlbSignalData = MLBSignal;

const PITCH_LABELS: Record<string, string> = {
  FF: "4-Seam", SI: "Sinker", FC: "Cutter", SL: "Slider",
  CU: "Curve", CH: "Change", FS: "Splitter", KC: "Knuckle Curve",
  KN: "Knuckle", EP: "Eephus", ST: "Sweeper", SV: "Slurve",
};

const DRIVER_LABELS: Record<string, string> = {
  contactQuality: "Contact",
  batSpeedPower: "Power",
  handednessMatchup: "Matchup",
  pitchBlendMatchup: "Pitch Mix",
  hotColdForm: "Form",
  parkEnv: "Park/Env",
  bvp: "BvP",
  lineupOpportunity: "Lineup",
  bullpenFactor: "Bullpen",
  pitcherSuppression: "Pitcher",
  pitcherDeterioration: "Fatigue",
};

function driverColor(val: number): string {
  if (val >= 0.65) return "#22c55e";
  if (val >= 0.55) return "#a3e635";
  if (val >= 0.45) return "#94a3b8";
  if (val >= 0.35) return "#f59e0b";
  return "#ef4444";
}

function stabilityLabel(score: number | null | undefined): { text: string; color: string } | null {
  if (score == null) return null;
  if (score >= 80) return { text: "LOCKED", color: "#22c55e" };
  if (score >= 60) return { text: "STABLE", color: "#a3e635" };
  if (score >= 40) return { text: "FLUID", color: "#f59e0b" };
  return { text: "VOLATILE", color: "#ef4444" };
}

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
  const form = formBadge(sig.formIndicator ?? null);
  const sideOdds = sig.recommendedSide === "OVER" ? sig.overOdds : sig.underOdds;
  const liveStat = getMlbLiveStatValue(sig);
  const tags = [
    ...(sig.badges ?? []),
    ...(sig.signalTags ?? []).slice(0, 4),
  ].slice(0, 5);
  const cardOpacity = sig.stale ? 0.5 : sig.alreadyHit ? 0.75 : 1;
  const isClickable = !!(onPlayerClick && sig.gameId);
  const allReasons = sig.explanationBullets?.length ? sig.explanationBullets : sig.reasons?.length ? sig.reasons : [];

  const warningTags: string[] = [];
  if (sig.isDegraded || sig.dataQuality === "degraded") warningTags.push("Limited Data");
  if (sig.dataQuality === "partial") warningTags.push("Partial Data");
  if (sig.safetyCeilingApplied) warningTags.push("Ceiling Applied");
  const riskFlags = sig.riskFlags ?? [];

  const inningText = sig.inning && sig.inning > 0 ? `Inn ${sig.inning}` : null;

  const detectionLabel = `${sig.recommendedSide} ${sig.bookLine ?? ""} ${marketLabel}`.trim();
  const stability = stabilityLabel(sig.signalScore);
  const drivers = sig.drivers ?? {};
  const activeDrivers = Object.entries(drivers)
    .filter(([k, v]) => DRIVER_LABELS[k] && Math.abs(v - 0.5) >= 0.05)
    .sort(([, a], [, b]) => Math.abs(b - 0.5) - Math.abs(a - 0.5));

  return (
    <div
      data-testid={`mlb-signal-${sig.playerId}-${sig.market}`}
      className={`rounded-xl border border-border/40 bg-card transition-all ${isClickable ? "cursor-pointer" : ""}`}
      style={{ opacity: cardOpacity }}
      role={isClickable ? "button" : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onClick={isClickable ? () => onPlayerClick!(sig.gameId!, sig.playerId) : undefined}
      onKeyDown={isClickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPlayerClick!(sig.gameId!, sig.playerId); } } : undefined}
    >
      <div
        className="p-3 space-y-2"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setExpanded(!expanded); } }}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
            <span
              className="text-[9px] font-black px-2 py-0.5 rounded-full"
              style={{ background: tier.bg, color: tier.text, border: `1px solid ${tier.border}` }}
              data-testid={`badge-tier-${sig.playerId}-${sig.market}`}
            >
              {tier.badge}
            </span>
            <span
              className="text-[9px] font-black px-2 py-0.5 rounded-full"
              style={{ background: side.bg, color: side.accent, border: `1px solid ${side.border}` }}
            >
              {side.label}
            </span>
            {form && (
              <span className="text-[9px] font-semibold" style={{ color: form.color }}>
                {form.label}
              </span>
            )}
            {sig.alreadyHit && (
              <span className="text-[8px] font-black px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                HIT ✓
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0 text-[10px] text-muted-foreground">
            {matchup && <span>{matchup}</span>}
            {inningText && <span>{inningText}</span>}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1">
              <span className="text-xs font-bold text-foreground truncate">{sig.playerName}</span>
              {isClickable && <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />}
            </div>
            <p className="text-[10px] font-semibold" style={{ color: side.accent }}>
              {detectionLabel}
              {sideOdds != null && <span className="ml-1 text-muted-foreground font-normal">({formatAmericanOdds(sideOdds)})</span>}
            </p>
          </div>
          <div className="flex flex-col items-end shrink-0">
            <span className="text-lg font-black tabular-nums" style={{ color: side.accent }}>
              {sig.enginePct.toFixed(0)}%
            </span>
            {stability && (
              <span className="text-[8px] font-bold" style={{ color: stability.color }}>
                {stability.text}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 text-[10px] flex-wrap">
          {sig.edge != null && (
            <span className="text-muted-foreground/70">
              Edge: <span className="font-bold" style={{ color: sig.edge > 0 ? "#22c55e" : "#ef4444" }}>
                {sig.edge > 0 ? "+" : ""}{sig.edge.toFixed(1)}%
              </span>
            </span>
          )}
          {sig.projection != null && (
            <span className="text-muted-foreground/70">
              Proj: <span className="text-foreground font-semibold">{sig.projection.toFixed(2)}</span>
            </span>
          )}
          {liveStat ? (
            <span className="text-muted-foreground/70">
              {liveStat.label}: <span className="font-semibold" style={{ color: liveStat.value >= (sig.bookLine ?? 99) ? "#22c55e" : "#ffffff" }}>
                {liveStat.value}/{sig.bookLine}
              </span>
            </span>
          ) : null}
          <span className="text-muted-foreground/70">
            S: <span className="text-foreground font-semibold">{sig.signalScore ?? 0}</span>
          </span>
        </div>

        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tags.map((tag) => (
              <span key={tag} className="text-[8px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: "rgba(255,255,255,0.06)", color: "#d4d4d8" }}>
                {tag}
              </span>
            ))}
            {warningTags.map((tag) => (
              <span key={tag} className="text-[8px] px-1.5 py-0.5 rounded-full font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                {tag}
              </span>
            ))}
            {riskFlags.map((f) => (
              <span key={f} className="text-[8px] px-1.5 py-0.5 rounded-full font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                {f}
              </span>
            ))}
          </div>
        )}

        {expanded && (
          <div className="space-y-2 pt-1 border-t border-border/20 animate-in slide-in-from-top-1 duration-200">
            {sig.currentStats && (() => {
              const cs = sig.currentStats;
              return (
                <div className="flex items-center gap-2 py-1.5 px-2.5 rounded-lg bg-secondary/30 border border-border/20 text-[10px]">
                  <span className="text-muted-foreground font-semibold uppercase text-[9px] shrink-0">Today</span>
                  <div className="flex items-center gap-2 flex-wrap">
                    {(cs.ab ?? 0) > 0 && <span className="text-foreground font-semibold">{cs.h ?? 0}-{cs.ab}</span>}
                    {(cs.hr ?? 0) > 0 && <span className="text-orange-400 font-bold">{cs.hr} HR</span>}
                    {(cs.rbi ?? 0) > 0 && <span className="text-muted-foreground">{cs.rbi} RBI</span>}
                    {(cs.bb ?? 0) > 0 && <span className="text-muted-foreground">{cs.bb} BB</span>}
                    {(cs.k ?? 0) > 0 && <span className="text-red-400">{cs.k} K</span>}
                    {(cs.tb ?? 0) > 0 && <span className="text-muted-foreground">{cs.tb} TB</span>}
                  </div>
                </div>
              );
            })()}

            {sig.pitchMix && sig.pitchMix.length > 0 && (
              <div className="rounded-lg p-2.5 bg-secondary/20 border border-border/20 space-y-1">
                <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Pitcher Arsenal</div>
                <div className="flex flex-wrap gap-1">
                  {sig.pitchMix.slice(0, 5).map((p, i) => (
                    <span key={i} className="text-[9px] px-1.5 py-0.5 rounded bg-secondary/60 text-foreground border border-border/30">
                      {PITCH_LABELS[p.pitchType] ?? p.pitchType} {Math.round(p.percentage)}%
                      {p.avgVelocity != null && <span className="text-muted-foreground ml-1">{p.avgVelocity.toFixed(0)}mph</span>}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {sig.bvp && sig.bvp.atBats > 0 && (
              <div className="text-[9px] px-2.5 py-1.5 rounded-lg bg-secondary/20 border border-border/20">
                <span className="text-muted-foreground/70">BvP: </span>
                <span className="text-foreground font-semibold">{sig.bvp.hits}/{sig.bvp.atBats}</span>
                <span className="text-muted-foreground/50 ml-1">({sig.bvp.avg != null ? sig.bvp.avg.toFixed(3) : "—"})</span>
                {sig.bvp.homeRuns > 0 && <span className="text-orange-400 ml-1.5 font-semibold">{sig.bvp.homeRuns} HR</span>}
              </div>
            )}

            {allReasons.length > 0 && (
              <div className="space-y-0.5 pl-1">
                <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider mb-0.5">Why this signal?</div>
                {allReasons.slice(0, 4).map((r, i) => (
                  <p key={i} className="text-[9px] text-muted-foreground/80 leading-tight flex items-start gap-1">
                    <span className="mt-px" style={{ color: side.accent }}>•</span>
                    <span>{r}</span>
                  </p>
                ))}
              </div>
            )}

            {activeDrivers.length > 0 && (
              <div className="rounded-lg p-2.5 bg-secondary/20 border border-border/20">
                <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">Driver Scores</div>
                <div className="grid grid-cols-3 gap-x-3 gap-y-1">
                  {activeDrivers.slice(0, 6).map(([key, val]) => (
                    <div key={key} className="flex items-center justify-between gap-1">
                      <span className="text-[8px] text-muted-foreground truncate">{DRIVER_LABELS[key]}</span>
                      <div className="flex items-center gap-1">
                        <div className="w-8 h-1 rounded-full bg-secondary/60 overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${Math.round(val * 100)}%`, backgroundColor: driverColor(val) }}
                          />
                        </div>
                        <span className="text-[7px] font-bold tabular-nums" style={{ color: driverColor(val) }}>
                          {(val * 100).toFixed(0)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between px-3 py-2 border-t border-border/20" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-1 text-[9px] text-muted-foreground">
          {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          <button
            data-testid={`button-expand-${sig.playerId}-${sig.market}`}
            className="hover:text-foreground transition-colors"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Less" : "More"}
          </button>
        </div>
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
