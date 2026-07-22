// MLB Mound Radar — user-facing surface ("The Mound").
//
// Renders server-stamped pitcher targets (score / tier / drivers verbatim).
// NO client-side scoring or tier derivation. Pitcher-positive markets only —
// Pitcher Strikeouts / Pitcher Outs Recorded. Never an "allowed" market.
// Mirrors PregamePowerRadar.tsx's structure/styling exactly — separate
// component, no shared card markup with the Plate board.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Flame, Zap, Target, Wind, ShieldAlert, Lock, PartyPopper, ChevronDown, ChevronUp, Check } from "lucide-react";
import { MoundRadarRecord, MoundRadarFadeRecord } from "./MoundWinCard";
import { getSetupGrade } from "@/lib/mlb/setupGrade";
import { baselineOnlyLabel } from "@/lib/mlb/moundSettlementLabels";

type Tier = "track" | "watch" | "strong" | "elite" | "nuclear";
type Market = "pitcher_strikeouts" | "pitcher_outs";

interface MoundDriver {
  key: string;
  label: string;
  direction: "positive" | "negative" | "neutral";
  evidence?: string;
}

type SetupLabel = "Elite" | "Strong" | "Solid" | "Weak";

interface MarketSetup {
  market: Market;
  setupScore: number;
  setupLabel: SetupLabel;
  isPrimary: boolean;
}

/** Line-aware, Over/Under-aware value read vs. the posted pitcher-strikeouts line only. Server-stamped, display-only — never re-derived client-side. */
interface KLineValue {
  side: "Over" | "Under" | "No Edge";
  label: SetupLabel;
  margin: number;
  line: number;
  projection: number;
}

interface ParkContext {
  venueName: string | null;
  temperatureF: number | null;
  windMph: number | null;
  windDirectionLabel: string | null;
  runEnvironmentLabel: "Run Suppression" | "Neutral Air" | "Neutral Conditions" | "Conditions Unavailable";
  runEnvironmentType: "suppress" | "neutral" | "unknown";
  driverText?: string | null;
}

interface MoundOutcome {
  outcome?: "mound_win" | "mound_fade_win" | "mound_calibration_miss";
  userVisible?: boolean;
  finalStrikeouts?: number | null;
  finalOutsRecorded?: number | null;
  /** Internal model-calibration baseline (season K/9 or outs-per-start) — the number deriveMoundOutcome graded against. Never the settlement basis for "Cashed"; see MoundSettlementView. */
  seasonBaselineValue?: number | null;
}

/**
 * The public settlement-view contract — server-computed fresh per response
 * (buildMoundSettlementView), the ONLY shape this card reads to decide
 * Cashed/Missed/Push vs. the baseline-only fallback labels. Never re-derived
 * client-side.
 */
interface MoundSettlementView {
  modelOutcome: "confirmed" | "not_confirmed" | "push" | null;
  modelBaseline: number | null;
  marketOutcome: "cashed" | "missed" | "push" | "unavailable";
  sportsbookLine: number | null;
  recommendedSide: "OVER" | "UNDER" | null;
  finalStat: number | null;
  /**
   * Was this ever a genuine public recommendation, independent of which
   * grading path (model vs. market) decided the outcome. NEVER derive this
   * from outcomes.userVisible client-side — that field is stamped false by
   * the server whenever the baseline comparison misses, even for a signal
   * that was genuinely publicly flagged and whose market outcome cashed.
   */
  isPublicRecommendation: boolean;
}

// Best-available real sportsbook line for pitcher_strikeouts, when posted.
// Mirrors server MoundMarketEdgeContext verbatim — display-only, never fed
// back into score10/tier.
interface MoundMarketEdgeContext {
  line?: number;
  odds?: number;
  impliedProbability?: number;
  sportsbook?: string;
  oddsUpdatedAt?: string;
}

// Diagnostics carried by the server-side MoundSignal (see
// server/mlb/pregame/mound/types.ts MoundDiagnostics) and already returned
// verbatim by the public API — surfaced here for the expanded detail view
// only. Display-only: never re-derived, never fed back into score10.
interface MoundDiagnosticsView {
  pitcherSkillScore: number | null;
  opponentKProfileScore: number | null;
  workloadScore: number | null;
  runEnvironmentScore: number | null;
  recentFormScore: number | null;
  marketFitScore: number | null;
  riskPenalty: number;
  dataCoverageScore: number;
  appliedWarnings: string[];
  rawInputsAvailable: { pitcherSeasonStats: boolean };
}

interface MoundSignal {
  signalId: string;
  gameId: string;
  startsAt: string | null;
  pitcherId: string;
  pitcherName: string;
  team: string;
  opponent: string;
  throws: "L" | "R" | null;
  opposingLineupConfirmed: boolean;
  opposingLineupLabel: string | null;
  primaryMarket: Market;
  marketTags: Market[];
  marketScores: Partial<Record<Market, number>>;
  marketSetups?: MarketSetup[];
  /** Pure pitcher-skill grade, independent of matchup. Server-stamped, display-only. User-facing badge text is "K Skill". */
  kStuffScore?: number;
  kStuffLabel?: SetupLabel;
  /** Pure platoon-matchup-fit grade. Server-stamped, display-only. User-facing badge text is "K Matchup". */
  platoonKFitScore?: number;
  platoonKFitLabel?: SetupLabel;
  platoonKFitReason?: "poor handedness fit" | null;
  /** Qualitative read on the numeric strikeout projection. Server-stamped, display-only. */
  kProjectionLabel?: "High" | "Good" | "Average" | "Low" | null;
  /** Value read vs. the posted pitcher-strikeouts line only. Server-stamped, display-only. Null when no line is posted. */
  kLineValue?: KLineValue | null;
  parkContext?: ParkContext | null;
  score10: number;
  tier: Tier;
  /** Server-stamped once at build time (moundDirection.ts) — display-only, never re-derived client-side. */
  moundDirection?: "fade" | "follow" | null;
  drivers: MoundDriver[];
  status: "active" | "locked" | "expired" | "graded";
  gameStatus: string;
  lineupStatus: string;
  becameLiveReady?: boolean;
  becameLiveFire?: boolean;
  outcomes?: MoundOutcome | null;
  /** Server-computed fresh per response — the sole source for Cashed/Missed/Push vs. baseline-only fallback labeling. */
  settlementView?: MoundSettlementView | null;
  diagnostics: MoundDiagnosticsView;
  marketEdgeContext?: MoundMarketEdgeContext | null;
  /** Settlement baseline — decides mound_win/mound_calibration_miss. */
  projectedStrikeouts?: number | null;
  /** Display-only enrichment (multi-year K/9 + opponent/BvP/park/recent-form) — never used for grading. */
  matchupAdjustedStrikeouts?: number | null;
}

interface MoundRadarResponse {
  date: string;
  buildId: string;
  generatedAt: string;
  source: string;
  gamesScanned: number;
  signals: MoundSignal[];
  diagnostics: {
    publicSignals: number;
    suppressedSignals: number;
    lineupCoverage: number;
  };
}

const TIER_STYLE: Record<Tier, { label: string; color: string; glow: string }> = {
  nuclear: { label: "Nuclear Setup", color: "#f43f5e", glow: "rgba(244,63,94,0.35)" },
  elite: { label: "Elite Setup", color: "#f59e0b", glow: "rgba(245,158,11,0.30)" },
  strong: { label: "Strong Setup", color: "#a78bfa", glow: "rgba(167,139,250,0.25)" },
  watch: { label: "Watch", color: "#94a3b8", glow: "rgba(148,163,184,0.15)" },
  track: { label: "Track", color: "#64748b", glow: "rgba(100,116,139,0.1)" },
};

const MARKET_LABEL: Record<Market, string> = {
  pitcher_strikeouts: "Pitcher Ks",
  pitcher_outs: "Pitcher Outs",
};

const MARKET_EMOJI: Record<Market, string> = {
  pitcher_strikeouts: "🎯",
  pitcher_outs: "🧤",
};

const RUN_ENV_EMOJI: Record<ParkContext["runEnvironmentLabel"], string> = {
  "Run Suppression": "🧊",
  "Neutral Air": "↔",
  "Neutral Conditions": "🏟️",
  "Conditions Unavailable": "🚫",
};

const RUN_ENV_COLOR: Record<ParkContext["runEnvironmentType"], string> = {
  suppress: "text-sky-300",
  neutral: "text-muted-foreground",
  unknown: "text-muted-foreground/70 italic",
};

type FilterKey =
  | "all"
  | "strikeouts"
  | "outs"
  | "elite"
  | "confirmed_starters"
  | "high_k"
  | "long_leash"
  | "weak_lineup"
  | "run_suppression"
  | "risk"
  | "follow"
  | "fade";

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "strikeouts", label: "Strikeouts" },
  { key: "outs", label: "Outs" },
  { key: "elite", label: "Elite+" },
  { key: "confirmed_starters", label: "Confirmed Starters" },
  { key: "high_k", label: "High K%" },
  { key: "long_leash", label: "Long Leash" },
  { key: "weak_lineup", label: "Weak Lineup" },
  { key: "run_suppression", label: "Run Suppression" },
  { key: "risk", label: "Risk Warnings" },
  { key: "follow", label: "Follow (Over)" },
  { key: "fade", label: "Fade (Under)" },
];

function hasDriver(s: MoundSignal, predicate: (d: MoundDriver) => boolean): boolean {
  return s.drivers.some((d) => d.direction === "positive" && predicate(d));
}

function formatAmericanOdds(odds: number): string {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

function getSetupLabelClasses(label?: SetupLabel | null): string {
  switch (label) {
    case "Elite":
      return "bg-emerald-500/20 text-emerald-200 border-emerald-400/30";
    case "Strong":
      return "bg-green-500/20 text-green-200 border-green-400/30";
    case "Solid":
      return "bg-amber-500/20 text-amber-200 border-amber-400/30";
    case "Weak":
      return "bg-rose-500/20 text-rose-200 border-rose-400/30";
    default:
      return "bg-secondary text-muted-foreground";
  }
}

function getProjectionLabelClasses(label?: "High" | "Good" | "Average" | "Low" | null): string {
  switch (label) {
    case "High":
      return "bg-sky-500/20 text-sky-200 border-sky-400/30";
    case "Good":
      return "bg-blue-500/20 text-blue-200 border-blue-400/30";
    case "Average":
      return "bg-slate-500/20 text-slate-200 border-slate-400/30";
    case "Low":
      return "bg-rose-500/20 text-rose-200 border-rose-400/30";
    default:
      return "bg-secondary text-muted-foreground";
  }
}

function getLineValueClasses(label?: SetupLabel | null): string {
  switch (label) {
    case "Elite":
      return "bg-emerald-500/20 text-emerald-200 border-emerald-400/30";
    case "Strong":
      return "bg-green-500/20 text-green-200 border-green-400/30";
    case "Solid":
      return "bg-lime-500/20 text-lime-200 border-lime-400/30";
    case "Weak":
      return "bg-rose-500/20 text-rose-200 border-rose-400/30";
    default:
      return "bg-secondary text-muted-foreground";
  }
}

function MoundTagColorKey() {
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none text-[11px] font-semibold hover:text-foreground">
        ⓘ Tag Color Key
      </summary>

      <div className="mt-2 grid gap-1.5 rounded-lg border border-border/30 bg-secondary/20 p-2 text-[11px]">
        <div>
          <span className="font-semibold text-green-300">Green</span>
          {" = Advantage — positive skill, matchup, or market signal"}
        </div>

        <div>
          <span className="font-semibold text-amber-300">Amber</span>
          {" = Solid / usable — decent support, not a standout edge"}
        </div>

        <div>
          <span className="font-semibold text-sky-300">Blue</span>
          {" = Projection info — expected output only, not a bet by itself"}
        </div>

        <div>
          <span className="font-semibold text-rose-300">Rose</span>
          {" = Risk / caution — something working against the setup"}
        </div>

        <div className="pt-1 text-muted-foreground/80">
          The setup grade badge (top-right of each card) uses its own tier color and is separate from these tag colors.
        </div>
      </div>
    </details>
  );
}

export function MoundPowerRadar({ selectedGameId = null }: { selectedGameId?: string | null } = {}) {
  const [filter, setFilter] = useState<FilterKey>("all");

  const { data, isLoading } = useQuery<MoundRadarResponse>({
    queryKey: ["/api/mlb/mound-power-radar/all-starters"],
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });

  const signals = useMemo(() => {
    const allSignals = data?.signals ?? [];
    // Server (buildMoundResponse) already sorts by score10 descending — kept
    // as-is so Follow candidates and Fade candidates sit at the two visual
    // ends of this single unified list.
    return allSignals.filter((s) => {
      if (selectedGameId && s.gameId !== selectedGameId) return false;
      switch (filter) {
        case "strikeouts": return s.marketTags.includes("pitcher_strikeouts");
        case "outs": return s.marketTags.includes("pitcher_outs");
        case "elite": return s.tier === "elite" || s.tier === "nuclear";
        case "confirmed_starters": return hasDriver(s, (d) => d.key === "ctx_confirmed_starter");
        case "high_k": return hasDriver(s, (d) => d.key.startsWith("ps_"));
        case "long_leash": return hasDriver(s, (d) => d.key === "wl_leash");
        case "weak_lineup": return hasDriver(s, (d) => d.key === "okp_platoon");
        case "run_suppression": return hasDriver(s, (d) => d.key.startsWith("re_"));
        case "risk": return s.drivers.some((d) => d.direction === "negative");
        case "follow": return s.moundDirection === "follow";
        case "fade": return s.moundDirection === "fade";
        default: return true;
      }
    });
  }, [data, filter, selectedGameId]);

  return (
    <div className="space-y-3" data-testid="section-mound-radar">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Target className="w-5 h-5 text-amber-400" />
            The Mound
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Pitcher targets from today's probable starters — strikeout and workload setups, not guarantees.
          </p>
        </div>
        {data && (
          <div className="text-[11px] text-muted-foreground text-right">
            <div>
              {data.signals.length} starters · {data.diagnostics.publicSignals} curated · {data.gamesScanned} games
            </div>
            <div className="opacity-70">source: {data.source}</div>
          </div>
        )}
      </div>

      <div className="flex gap-1.5 flex-wrap">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            data-testid={`filter-mound-${f.key}`}
            onClick={() => setFilter(f.key)}
            className={`px-3 py-1 rounded-full text-[11px] font-semibold transition-all border ${
              filter === f.key
                ? "bg-amber-500/20 border-amber-400/40 text-amber-200"
                : "bg-secondary/40 border-border/50 text-muted-foreground hover:text-foreground"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <MoundRadarRecord />
      <MoundRadarFadeRecord />

      {isLoading && !data && (
        <Card className="p-6 text-center text-sm text-muted-foreground">Loading mound targets…</Card>
      )}

      {data && signals.length === 0 && (
        <Card className="p-8 text-center" data-testid="empty-mound-radar">
          <Target className="w-8 h-8 mx-auto mb-2 text-muted-foreground/50" />
          <p className="text-sm font-medium">Waiting for probable starters.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Starters appear once today's probable pitchers are announced.
          </p>
        </Card>
      )}

      <MoundTagColorKey />

      <div className="grid gap-2.5">
        {signals.map((s) => (
          <MoundCard key={s.signalId} signal={s} />
        ))}
      </div>
    </div>
  );
}

const FADE_COLOR = "#f43f5e";
const FADE_GLOW = "rgba(244,63,94,0.28)";
const FOLLOW_COLOR = "#34d399";

function MoundCard({ signal: s }: { signal: MoundSignal }) {
  const style = TIER_STYLE[s.tier];
  const TierIcon = s.tier === "nuclear" || s.tier === "elite" ? Flame : s.tier === "strong" ? Zap : Target;
  const positives = s.drivers.filter((d) => d.direction === "positive").slice(0, 4);
  const negatives = s.drivers.filter((d) => d.direction === "negative").slice(0, 4);
  const isLocked = s.status === "locked";
  // Server-stamped once at build time (moundDirection.ts) — display-only,
  // never re-derived here.
  const direction = s.moundDirection ?? null;
  const isFade = direction === "fade";
  const isFollow = direction === "follow";

  // Was this signal ever a genuine public recommendation? Orthogonal to
  // which grading basis decides the label. NEVER outcomes.userVisible — the
  // server stamps that false whenever the BASELINE comparison misses, even
  // for a signal that was genuinely publicly flagged and whose MARKET
  // outcome cashed. settlementView.isPublicRecommendation is sourced from
  // the durable everPubliclyFlagged/everPubliclyFlaggedFade flags instead.
  const isPubliclyGraded = s.status === "graded" && s.settlementView?.isPublicRecommendation === true;
  const marketOutcome = s.settlementView?.marketOutcome ?? "unavailable";
  // The ONLY thing allowed to drive "Cashed"/"Missed"/"Push" — never the
  // baseline-graded outcomes.outcome, which is internal calibration only.
  const cashed = isPubliclyGraded && marketOutcome === "cashed";
  const isPush = isPubliclyGraded && marketOutcome === "push";
  const isMissed = isPubliclyGraded && marketOutcome === "missed";
  const isUnavailableFallback = isPubliclyGraded && marketOutcome === "unavailable";
  const fallbackLabel = isUnavailableFallback
    ? baselineOnlyLabel(s.settlementView?.modelOutcome ?? null, s.settlementView?.recommendedSide ?? null)
    : null;
  const isFadeCash = cashed && isFade;
  const cashedColor = "#10b981";
  const pushColor = "#eab308";
  const fallbackColor = "#38bdf8";
  const accentColor = cashed
    ? cashedColor
    : isPush
      ? pushColor
      : isUnavailableFallback && fallbackLabel
        ? fallbackColor
        : isFade
          ? FADE_COLOR
          : style.color;

  const marketSetups: MarketSetup[] =
    s.marketSetups && s.marketSetups.length > 0
      ? s.marketSetups
      : s.marketTags.map((m) => ({
          market: m,
          setupScore: s.marketScores[m] ?? 0,
          setupLabel: undefined as unknown as SetupLabel,
          isPrimary: m === s.primaryMarket,
        }));

  const slug = s.pitcherName.replace(/\s+/g, "-").toLowerCase();
  const [expanded, setExpanded] = useState(false);

  return (
    <Card
      className={`p-3.5 transition-colors duration-500 ${cashed ? "bg-emerald-500/10" : ""}`}
      style={{
        boxShadow: cashed ? `0 0 22px rgba(16,185,129,0.45)` : `0 0 14px ${isFade ? FADE_GLOW : style.glow}`,
        borderColor: cashed ? cashedColor + "99" : accentColor + "55",
      }}
      data-testid={`card-mound-${slug}`}
    >
      <div
        className="cursor-pointer"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded(!expanded); } }}
      >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-sm truncate">{s.pitcherName}</span>
            <span className="text-[11px] text-muted-foreground">
              {s.team} vs {s.opponent}
            </span>
            {cashed && (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-300 animate-pulse"
                data-testid={`mound-cashed-${slug}`}
              >
                <PartyPopper className="w-3 h-3" /> CASHED
              </span>
            )}
            {/* A real frozen sportsbook line existed and landed exactly on it — reserved exclusively for a real market push, never the baseline-tie case (see baselineOnlyLabel). */}
            {isPush && (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-300"
                data-testid={`mound-push-${slug}`}
              >
                Push
              </span>
            )}
            {/* No real sportsbook line was ever captured for this signal — never
                "Cashed"/"Missed"/"Push" here, only the honest baseline-only
                model-read label. */}
            {isUnavailableFallback && fallbackLabel && (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-semibold"
                style={{ color: fallbackColor }}
                data-testid={`mound-model-outcome-${slug}`}
              >
                {fallbackLabel}
              </span>
            )}
            {/* Completed public Follow card that missed the market — factual
                "Final" marker so a graded miss stays visible as a completed
                row, not erased. Follow only (Fade is publicly absent). */}
            {isMissed && isFollow && (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-semibold text-muted-foreground"
                data-testid={`mound-final-${slug}`}
              >
                Final
              </span>
            )}
            {isLocked && !cashed && (
              <span className="inline-flex items-center gap-1 text-[10px] text-amber-300/90">
                <Lock className="w-3 h-3" /> Locked at first pitch
              </span>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            {s.opposingLineupLabel ?? `vs ${s.opponent}`}
            {s.throws ? ` · ${s.throws}HP` : ""}
          </div>
          {/* Skill/workload comparison only, no line context — deliberately not
              "Best Market"/"Best Bet" (those read as a betting recommendation). */}
          <div className="text-[10px] text-muted-foreground/80 mt-0.5" data-testid={`mound-best-angle-${slug}`}>
            Best Angle: {s.primaryMarket === "pitcher_strikeouts" ? "Pitcher Ks" : "Pitcher Outs"}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-xl font-extrabold tabular-nums" style={{ color: accentColor }}>
            {getSetupGrade(s.score10)}
          </div>
          <div
            className="inline-flex items-center gap-1 text-[10px] font-semibold"
            style={{ color: accentColor }}
          >
            {cashed ? (
              <PartyPopper className="w-3 h-3" />
            ) : isPush || (isUnavailableFallback && fallbackLabel) ? null : isFade ? (
              <ShieldAlert className="w-3 h-3" />
            ) : (
              <TierIcon className="w-3 h-3" />
            )}
            {cashed
              ? isFadeCash
                ? "Faded — Cashed"
                : "Cashed"
              : isPush
                ? "Push"
                : isUnavailableFallback && fallbackLabel
                  ? fallbackLabel
                  : isFade
                    ? "Fade Candidate"
                    : style.label}
          </div>
          {!cashed && !isPush && !isUnavailableFallback && (isFade || isFollow) && (
            <div
              className="text-[9px] font-bold mt-0.5"
              style={{ color: isFade ? FADE_COLOR : FOLLOW_COLOR }}
              data-testid={`mound-direction-${isFade ? "fade" : "follow"}`}
            >
              {isFade ? "▼ Fade (Under)" : "▲ Follow (Over)"}
            </div>
          )}
        </div>
      </div>

      <SettlementRow signal={s} />

      <RunEnvironmentRow park={s.parkContext} />
      <StrikeoutLineRow
        projectedStrikeouts={s.projectedStrikeouts}
        matchupAdjustedStrikeouts={s.matchupAdjustedStrikeouts}
        edge={s.marketEdgeContext}
      />

      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
        {/* K Skill — pure pitcher-skill grade (kStuffLabel internally), never
            blended with matchup. Always shown. */}
        {s.kStuffLabel && (
          <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 border ${getSetupLabelClasses(s.kStuffLabel)}`}>
            💪 K Skill · {s.kStuffLabel}
          </Badge>
        )}
        {s.kProjectionLabel && (
          <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 border ${getProjectionLabelClasses(s.kProjectionLabel)}`}>
            📈 K Projection · {s.kProjectionLabel}
          </Badge>
        )}
        {/* The old blended "Pitcher Ks" market badge is intentionally never
            rendered here — only pitcher_outs (workload-only, no blending
            issue) keeps its market badge. */}
        {marketSetups
          .filter((setup) => setup.market === "pitcher_outs")
          .map((setup) => (
            <Badge
              key={setup.market}
              variant="secondary"
              className={`text-[10px] px-1.5 py-0 border ${getSetupLabelClasses(setup.setupLabel)}`}
            >
              {MARKET_EMOJI[setup.market]} {MARKET_LABEL[setup.market]}
              {setup.setupLabel ? ` · ${setup.setupLabel}` : ""}
            </Badge>
          ))}
        {/* K Matchup (platoonKFitLabel internally) hidden for "Solid" — the
            ordinary/neutral case (league-average platoon matchup) adds no
            information. Only a real edge (Weak, or Elite/Strong) is shown. */}
        {s.platoonKFitLabel && s.platoonKFitLabel !== "Solid" && (
          <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 border ${getSetupLabelClasses(s.platoonKFitLabel)}`}>
            🧩 K Matchup · {s.platoonKFitLabel}
            {s.platoonKFitLabel === "Weak" && s.platoonKFitReason ? ` (${s.platoonKFitReason})` : ""}
          </Badge>
        )}
        {/* K Over/K Under hidden on the compact card for "No Edge" — a
            non-play isn't worth a top-level chip; only a real Over or Under
            edge shows here, always with its own margin/line so the label is
            self-explanatory without a tooltip. */}
        {s.kLineValue && s.kLineValue.side !== "No Edge" && (
          <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 border ${getLineValueClasses(s.kLineValue.label)}`}>
            💰 K {s.kLineValue.side} · {s.kLineValue.label}{" "}
            {s.kLineValue.margin >= 0 ? "+" : ""}
            {s.kLineValue.margin} vs {s.kLineValue.line}
          </Badge>
        )}
      </div>

      {positives.length > 0 && (
        <div className="flex items-start gap-1.5 mt-2 flex-wrap">
          {positives.map((d) => (
            <span
              key={d.key}
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-300 border border-emerald-500/20"
              title={d.evidence}
            >
              {d.key.startsWith("re_wind") ? <Wind className="w-3 h-3" /> : d.key.startsWith("okp_") ? <ShieldAlert className="w-3 h-3" /> : null}
              {d.label}
            </span>
          ))}
        </div>
      )}

      {/* Warnings render separately from positive drivers, caution style (not green). */}
      {negatives.length > 0 && (
        <div className="flex items-start gap-1.5 mt-2 flex-wrap" data-testid={`mound-warnings-${slug}`}>
          {negatives.map((d) => (
            <span
              key={d.key}
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md bg-rose-500/10 text-rose-300 border border-rose-500/20"
              title={d.evidence}
            >
              <ShieldAlert className="w-3 h-3" />
              {d.label}
            </span>
          ))}
        </div>
      )}
      </div>

      <div className="flex items-center justify-end mt-2 pt-1.5 border-t border-border/20" onClick={(e) => e.stopPropagation()}>
        <button
          data-testid={`button-expand-mound-${slug}`}
          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {expanded ? "Less" : "Expand Details"}
        </button>
      </div>

      {expanded && (
        <div
          className="mt-2 pt-2.5 border-t border-border/20 animate-in slide-in-from-top-1 duration-200"
          onClick={(e) => e.stopPropagation()}
          data-testid={`mound-expanded-${slug}`}
        >
          <MoundExpandedDetail signal={s} />
        </div>
      )}
    </Card>
  );
}

// Public settlement context, rendered directly beneath the header pill on
// the compact card (never hidden behind Expand Details) — omitted entirely
// when the signal isn't a graded, publicly-flagged recommendation, matching
// this file's "missing data degrades to omitted" convention. Never re-derives
// Cashed/Missed/Push/the fallback labels — reads settlementView verbatim.
function SettlementRow({ signal: s }: { signal: MoundSignal }) {
  // NEVER outcomes.userVisible here — see MoundCard's identical gate for why.
  const isPubliclyGraded = s.status === "graded" && s.settlementView?.isPublicRecommendation === true;
  if (!isPubliclyGraded) return null;

  const settlement = s.settlementView;
  const marketOutcome = settlement?.marketOutcome ?? "unavailable";
  const marketLabel = MARKET_LABEL[s.primaryMarket];
  const unit = s.primaryMarket === "pitcher_strikeouts" ? "Ks" : "Outs";

  if (marketOutcome !== "unavailable") {
    const sideLabel = settlement?.recommendedSide === "UNDER" ? "Under" : "Over";
    const resultLabel = marketOutcome === "cashed" ? "Cashed" : marketOutcome === "missed" ? "Missed" : "Push";
    return (
      <div className="flex flex-col gap-0.5 mt-1.5 text-[11px]" data-testid="mound-settlement-row">
        <div className="flex items-center gap-1.5 flex-wrap text-muted-foreground">
          <span>
            Official Side <span className="font-semibold text-foreground">{sideLabel} {marketLabel}</span>
          </span>
          {settlement?.sportsbookLine != null && (
            <>
              <span className="opacity-40">·</span>
              <span>
                Sportsbook Line <span className="font-semibold text-foreground">{settlement.sportsbookLine}</span>
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap text-muted-foreground">
          {settlement?.finalStat != null && (
            <span>
              Final <span className="font-semibold text-foreground">{settlement.finalStat} {unit}</span>
            </span>
          )}
          <span className="opacity-40">·</span>
          <span>
            Result <span className="font-semibold text-foreground">{resultLabel}</span>
          </span>
        </div>
      </div>
    );
  }

  // No real sportsbook line was ever captured — show the baseline-only
  // model context instead. Never renders Cashed/Missed/Push here.
  const fallbackLabel = baselineOnlyLabel(settlement?.modelOutcome ?? null, settlement?.recommendedSide ?? null);
  if (fallbackLabel == null && settlement?.modelBaseline == null) return null;

  return (
    <div className="flex flex-col gap-0.5 mt-1.5 text-[11px]" data-testid="mound-settlement-row-fallback">
      <div className="flex items-center gap-1.5 flex-wrap text-muted-foreground">
        {settlement?.modelBaseline != null && (
          <span>
            Engine Baseline <span className="font-semibold text-foreground">{settlement.modelBaseline} {unit}</span>
          </span>
        )}
        {settlement?.finalStat != null && (
          <>
            <span className="opacity-40">·</span>
            <span>
              Final <span className="font-semibold text-foreground">{settlement.finalStat} {unit}</span>
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// Server-computed strikeout line context (see server MoundSignal). Omitted
// entirely when neither value is available — never a placeholder, matching
// this file's "missing data degrades to omitted" convention.
//
// Projected Ks = the settlement baseline (decides mound_win/mound_calibration_miss).
// Matchup Adj. Ks = a richer, separately-computed context number for user
// insight only — never used for grading. Always shown as a distinct line
// so the two are never confused.
function StrikeoutLineRow({
  projectedStrikeouts,
  matchupAdjustedStrikeouts,
  edge,
}: {
  projectedStrikeouts?: number | null;
  matchupAdjustedStrikeouts?: number | null;
  edge?: MoundMarketEdgeContext | null;
}) {
  if (projectedStrikeouts == null && matchupAdjustedStrikeouts == null && !edge) return null;

  return (
    <div className="flex flex-col gap-0.5 mt-1.5 text-[11px]" data-testid="mound-strikeout-line">
      <div className="flex items-center gap-1.5 flex-wrap">
        {projectedStrikeouts != null && (
          <span className="text-muted-foreground">
            🎯 Projected Ks <span className="font-semibold text-foreground">{projectedStrikeouts.toFixed(1)}</span>
          </span>
        )}
        {projectedStrikeouts != null && edge && <span className="opacity-40">·</span>}
        {edge && edge.line != null && (
          <span className="text-muted-foreground">
            Best Line{" "}
            <span className="font-semibold text-foreground">
              O{edge.line} {edge.odds != null ? formatAmericanOdds(edge.odds) : ""}
            </span>
            {edge.sportsbook ? ` · ${edge.sportsbook}` : ""}
          </span>
        )}
      </div>
      {matchupAdjustedStrikeouts != null && (
        <div className="text-muted-foreground" data-testid="mound-matchup-adjusted-ks">
          📈 Matchup Adj. Ks <span className="font-semibold text-foreground">{matchupAdjustedStrikeouts.toFixed(1)}</span>
        </div>
      )}
    </div>
  );
}

function RunEnvironmentRow({ park }: { park?: ParkContext | null }) {
  if (!park) {
    return (
      <div
        className="flex items-center gap-1.5 mt-1.5 text-[11px] text-muted-foreground/70 italic flex-wrap"
        data-testid="mound-park-conditions-unavailable"
      >
        <span>🏟️ Park context unavailable</span>
      </div>
    );
  }

  const hasContext = park.venueName != null || park.temperatureF != null || park.windMph != null;
  if (!hasContext && park.runEnvironmentType === "unknown") return null;

  const segments: JSX.Element[] = [];
  if (park.venueName) segments.push(<span key="venue">🏟️ {park.venueName}</span>);
  if (park.temperatureF != null) segments.push(<span key="temp">{Math.round(park.temperatureF)}°</span>);
  if (park.windMph != null) {
    segments.push(
      <span key="wind" className="inline-flex items-center gap-0.5">
        <Wind className="w-3 h-3" />
        {Math.round(park.windMph)}
        {park.windDirectionLabel ? ` ${park.windDirectionLabel}` : ""}
      </span>,
    );
  }
  segments.push(
    <span key="run-env" className={`font-semibold ${RUN_ENV_COLOR[park.runEnvironmentType]}`}>
      {RUN_ENV_EMOJI[park.runEnvironmentLabel]} {park.runEnvironmentLabel}
    </span>,
  );

  return (
    <div
      className="flex items-center gap-1.5 mt-1.5 text-[11px] text-muted-foreground flex-wrap"
      data-testid="mound-park-conditions"
      title={park.driverText ?? undefined}
    >
      {segments.map((seg, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          {i > 0 && <span className="opacity-40">·</span>}
          {seg}
        </span>
      ))}
    </div>
  );
}

// ── Expanded detail view (click-to-expand) ──────────────────────────────────
// Everything below renders ONLY inside the expanded block — the collapsed
// card above is untouched. All values are server-stamped (diagnostics /
// drivers already on MoundSignal); nothing here re-derives score10 or tier.
// Kept as its own copy (not shared with PregamePowerRadar.tsx) per this
// file's header comment: no shared card markup with the Plate board.

function PitcherAvatar({ id, name, size = 40 }: { id: string; name: string; size?: number }) {
  const [errored, setErrored] = useState(false);
  const initials = name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  const testSlug = name.replace(/\s+/g, "-").toLowerCase();

  if (!id || errored) {
    return (
      <div
        className="rounded-full bg-secondary/60 border border-border/40 flex items-center justify-center font-bold text-muted-foreground shrink-0"
        style={{ width: size, height: size, fontSize: size * 0.36 }}
        data-testid={`mound-avatar-initials-${testSlug}`}
      >
        {initials}
      </div>
    );
  }

  return (
    <img
      src={`https://midfield.mlbstatic.com/v1/people/${id}/spots/120`}
      alt={name}
      onError={() => setErrored(true)}
      className="rounded-full object-cover border border-border/40 shrink-0"
      style={{ width: size, height: size }}
      data-testid={`mound-avatar-photo-${testSlug}`}
    />
  );
}

function MoundSetupMeter({ score10, tier }: { score10: number; tier: Tier }) {
  const style = TIER_STYLE[tier];
  const pct = Math.max(0, Math.min(100, (score10 / 10) * 100));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[9px] font-bold uppercase tracking-wider">
        <span className="text-muted-foreground">Setup Meter</span>
        <span style={{ color: style.color }}>{style.label}</span>
      </div>
      <div className="h-1.5 rounded-full bg-secondary/60 overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: `linear-gradient(90deg, #38bdf8, ${style.color})` }}
        />
      </div>
    </div>
  );
}

function moundComponentBarColor(v: number): string {
  if (v >= 7) return "#22c55e";
  if (v >= 5) return "#eab308";
  return "#71717a";
}

function MoundComponentBar({ label, value }: { label: string; value: number }) {
  const pct = Math.max(0, Math.min(100, (value / 10) * 100));
  const color = moundComponentBarColor(value);
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[9px] text-muted-foreground truncate">{label}</span>
      <div className="flex items-center gap-1.5">
        <div className="w-16 h-1.5 rounded-full bg-secondary/60 overflow-hidden">
          <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
        </div>
        <span className="text-[8px] font-bold tabular-nums w-6 text-right" style={{ color }}>{value.toFixed(1)}</span>
      </div>
    </div>
  );
}

function moundCoverageLabel(v: number): { label: string; color: string } {
  if (v >= 0.8) return { label: "High", color: "#22c55e" };
  if (v >= 0.6) return { label: "Medium", color: "#eab308" };
  return { label: "Low", color: "#ef4444" };
}

// marketFitScore intentionally omitted: the server currently stamps it as a
// hardcoded 0 placeholder (server/mlb/pregame/mound/buildMlbMoundRadar.ts) —
// that scorer isn't implemented yet, so rendering it here would show a
// misleading "Market Fit 0.0" row that contradicts the real market-setup
// chips. Re-add once the server computes a real score.
const MOUND_COMPONENT_LABELS: Array<{ key: keyof MoundDiagnosticsView; label: string }> = [
  { key: "pitcherSkillScore", label: "Pitcher Skill" },
  { key: "opponentKProfileScore", label: "Opponent K Profile" },
  { key: "workloadScore", label: "Workload" },
  { key: "runEnvironmentScore", label: "Run Environment" },
  { key: "recentFormScore", label: "Recent Form" },
];

function MoundExpandedDetail({ signal: s }: { signal: MoundSignal }) {
  const diag = s.diagnostics;
  const allPositives = s.drivers.filter((d) => d.direction === "positive");
  const coverage = moundCoverageLabel(diag.dataCoverageScore);
  const components = MOUND_COMPONENT_LABELS
    .map(({ key, label }) => ({ label, value: diag[key] as number | null | undefined }))
    .filter((c): c is { label: string; value: number } => c.value != null);

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2.5">
        <PitcherAvatar id={s.pitcherId} name={s.pitcherName} />
        <div className="flex-1 min-w-0">
          <MoundSetupMeter score10={s.score10} tier={s.tier} />
        </div>
      </div>

      <div className="flex items-center justify-between text-[9px]">
        <span className="text-muted-foreground uppercase tracking-wider font-bold">Data Coverage</span>
        <span className="font-semibold" style={{ color: coverage.color }}>{coverage.label}</span>
      </div>

      {components.length > 0 && (
        <div className="rounded-lg p-2.5 bg-secondary/20 border border-border/20 space-y-1">
          <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Setup Breakdown</div>
          {components.map((c) => (
            <MoundComponentBar key={c.label} label={c.label} value={c.value} />
          ))}
          {diag.riskPenalty > 0 && (
            <div className="flex items-center justify-between gap-2 pt-1 mt-1 border-t border-border/20">
              <span className="text-[9px] text-muted-foreground truncate">Risk Penalty</span>
              <span className="text-[8px] font-bold tabular-nums text-rose-400">-{diag.riskPenalty.toFixed(1)}</span>
            </div>
          )}
        </div>
      )}

      {/* Full K decomposition, unconditional — always shows all four concepts
          (even "Solid" K Matchup, even "No Edge" K Line Value) regardless of
          what the compact card above filters out. */}
      <div className="rounded-lg p-2.5 bg-secondary/20 border border-border/20 space-y-1">
        <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1">K Decomposition</div>
        <div className="flex items-center justify-between gap-2 text-[10px]">
          <span className="text-muted-foreground">Model Score</span>
          <span className="font-semibold">{s.score10.toFixed(1)} / 10</span>
        </div>
        {s.kStuffLabel && (
          <div className="flex items-center justify-between gap-2 text-[10px]">
            <span className="text-muted-foreground">K Skill</span>
            <span className="font-semibold">
              {s.kStuffLabel}{s.kStuffScore != null ? ` (${s.kStuffScore.toFixed(1)})` : ""}
            </span>
          </div>
        )}
        {s.platoonKFitLabel && (
          <div
            className="flex items-center justify-between gap-2 text-[10px]"
            title="How today's projected lineup matches this pitcher's strikeout profile."
          >
            <span className="text-muted-foreground">K Matchup</span>
            <span className="font-semibold">
              {s.platoonKFitLabel}{s.platoonKFitScore != null ? ` (${s.platoonKFitScore.toFixed(1)})` : ""}
              {s.platoonKFitLabel === "Weak" && s.platoonKFitReason ? ` — ${s.platoonKFitReason}` : ""}
            </span>
          </div>
        )}
        {s.kProjectionLabel && (
          <div className="flex items-center justify-between gap-2 text-[10px]">
            <span className="text-muted-foreground">K Projection</span>
            <span className="font-semibold">
              {s.kProjectionLabel}
              {s.matchupAdjustedStrikeouts != null
                ? ` (${s.matchupAdjustedStrikeouts.toFixed(1)})`
                : s.projectedStrikeouts != null
                  ? ` (${s.projectedStrikeouts.toFixed(1)})`
                  : ""}
            </span>
          </div>
        )}
        {s.kLineValue && (
          <div className="flex items-center justify-between gap-2 text-[10px]">
            <span className="text-muted-foreground">K Line Value</span>
            <span className="font-semibold">
              {s.kLineValue.side === "No Edge"
                ? `No Edge (${s.kLineValue.projection.toFixed(1)} proj vs ${s.kLineValue.line})`
                : `${s.kLineValue.side} · ${s.kLineValue.label} ${s.kLineValue.margin >= 0 ? "+" : ""}${s.kLineValue.margin} vs ${s.kLineValue.line}`}
            </span>
          </div>
        )}
      </div>

      {/* Additive two-section settlement block — never touches K Decomposition
          above. MODEL EVALUATION is the internal calibration story (season
          baseline); MARKET RESULT is the public settlement story (real
          sportsbook line) and is omitted entirely — no placeholder — when no
          real line was ever captured for this signal. */}
      {s.status === "graded" && (
        <div className="rounded-lg p-2.5 bg-secondary/20 border border-border/20 space-y-1">
          <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Model Evaluation</div>
          {s.settlementView?.modelBaseline != null && (
            <div className="flex items-center justify-between gap-2 text-[10px]">
              <span className="text-muted-foreground">Engine Baseline</span>
              <span className="font-semibold">
                {s.settlementView.modelBaseline} {s.primaryMarket === "pitcher_strikeouts" ? "Ks" : "Outs"}
              </span>
            </div>
          )}
          {s.settlementView?.finalStat != null && (
            <div className="flex items-center justify-between gap-2 text-[10px]">
              <span className="text-muted-foreground">Final Result</span>
              <span className="font-semibold">
                {s.settlementView.finalStat} {s.primaryMarket === "pitcher_strikeouts" ? "Ks" : "Outs"}
              </span>
            </div>
          )}
          {(() => {
            const label = baselineOnlyLabel(s.settlementView?.modelOutcome ?? null, s.settlementView?.recommendedSide ?? null);
            return label ? (
              <div className="flex items-center justify-between gap-2 text-[10px]">
                <span className="text-muted-foreground">Model Outcome</span>
                <span className="font-semibold">{label}</span>
              </div>
            ) : null;
          })()}
        </div>
      )}

      {s.settlementView && s.settlementView.marketOutcome !== "unavailable" && (
        <div className="rounded-lg p-2.5 bg-secondary/20 border border-border/20 space-y-1">
          <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Market Result</div>
          <div className="flex items-center justify-between gap-2 text-[10px]">
            <span className="text-muted-foreground">Official Side</span>
            <span className="font-semibold">
              {s.settlementView.recommendedSide === "UNDER" ? "Under" : "Over"}
              {s.settlementView.sportsbookLine != null ? ` ${s.settlementView.sportsbookLine}` : ""}
              {" "}{s.primaryMarket === "pitcher_strikeouts" ? "Ks" : "Outs"}
            </span>
          </div>
          {s.settlementView.finalStat != null && (
            <div className="flex items-center justify-between gap-2 text-[10px]">
              <span className="text-muted-foreground">Final Result</span>
              <span className="font-semibold">
                {s.settlementView.finalStat} {s.primaryMarket === "pitcher_strikeouts" ? "Ks" : "Outs"}
              </span>
            </div>
          )}
          <div className="flex items-center justify-between gap-2 text-[10px]">
            <span className="text-muted-foreground">Market Outcome</span>
            <span className="font-semibold">
              {s.settlementView.marketOutcome === "cashed" ? "Cashed" : s.settlementView.marketOutcome === "missed" ? "Missed" : "Push"}
            </span>
          </div>
        </div>
      )}

      {allPositives.length > 0 && (
        <div className="rounded-lg p-2.5 bg-secondary/20 border border-border/20">
          <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">Why We Like This Arm</div>
          <ul className="space-y-1">
            {allPositives.map((d) => (
              <li key={d.key} className="flex items-start gap-1.5 text-[10px] text-foreground/90 leading-snug">
                <Check className="w-3 h-3 text-emerald-400 shrink-0 mt-0.5" />
                <span>
                  {d.label}
                  {d.evidence ? <span className="text-muted-foreground"> — {d.evidence}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {diag.appliedWarnings.length > 0 && (
        <div className="flex items-start gap-1.5 flex-wrap">
          {diag.appliedWarnings.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md bg-rose-500/10 text-rose-300 border border-rose-500/20"
            >
              <ShieldAlert className="w-3 h-3" /> {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
