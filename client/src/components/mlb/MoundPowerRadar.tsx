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
import { MoundRadarRecord } from "./MoundWinCard";

type Tier = "track" | "watch" | "strong" | "elite" | "nuclear";
type Market = "pitcher_strikeouts" | "pitcher_outs";

interface MoundDriver {
  key: string;
  label: string;
  direction: "positive" | "negative" | "neutral";
  evidence?: string;
}

type SetupLabel = "Elite" | "Strong" | "Solid" | "Watch";

interface MarketSetup {
  market: Market;
  setupScore: number;
  setupLabel: SetupLabel;
  isPrimary: boolean;
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
  outcome?: "mound_win" | "mound_calibration_miss";
  userVisible?: boolean;
  finalStrikeouts?: number | null;
  finalOutsRecorded?: number | null;
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
  parkContext?: ParkContext | null;
  score10: number;
  tier: Tier;
  drivers: MoundDriver[];
  status: "active" | "locked" | "expired" | "graded";
  gameStatus: string;
  lineupStatus: string;
  becameLiveReady?: boolean;
  becameLiveFire?: boolean;
  outcomes?: MoundOutcome | null;
  diagnostics: MoundDiagnosticsView;
  marketEdgeContext?: MoundMarketEdgeContext | null;
  projectedStrikeouts?: number | null;
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
  | "risk";

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
];

function hasDriver(s: MoundSignal, predicate: (d: MoundDriver) => boolean): boolean {
  return s.drivers.some((d) => d.direction === "positive" && predicate(d));
}

function formatAmericanOdds(odds: number): string {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

type MoundView = "targets" | "all";

export function MoundPowerRadar({ selectedGameId = null }: { selectedGameId?: string | null } = {}) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [view, setView] = useState<MoundView>("targets");

  const { data, isLoading } = useQuery<MoundRadarResponse>({
    queryKey: view === "all" ? ["/api/mlb/mound-power-radar/all-starters"] : ["/api/mlb/mound-power-radar"],
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });

  const signals = useMemo(() => {
    const allSignals = data?.signals ?? [];
    const filtered = allSignals.filter((s) => {
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
        default: return true;
      }
    });
    if (view !== "all") return filtered;
    // All Starters: today's full slate reads naturally in first-pitch order,
    // not ranked by score10 (the curated Targets feed's sort).
    return filtered.slice().sort((a, b) => {
      const ta = a.startsAt ? Date.parse(a.startsAt) : Infinity;
      const tb = b.startsAt ? Date.parse(b.startsAt) : Infinity;
      return ta - tb;
    });
  }, [data, filter, selectedGameId, view]);

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
              {view === "all" ? data.signals.length : data.diagnostics.publicSignals}{" "}
              {view === "all" ? "starters" : "targets"} · {data.gamesScanned} games
            </div>
            <div className="opacity-70">source: {data.source}</div>
          </div>
        )}
      </div>

      <div className="flex gap-1.5">
        {(["targets", "all"] as const).map((v) => (
          <button
            key={v}
            data-testid={`mound-view-${v}`}
            onClick={() => setView(v)}
            className={`px-3 py-1 rounded-full text-[11px] font-bold transition-all border ${
              view === v
                ? "bg-sky-500/20 border-sky-400/40 text-sky-200"
                : "bg-secondary/40 border-border/50 text-muted-foreground hover:text-foreground"
            }`}
          >
            {v === "targets" ? "Targets" : "All Starters"}
          </button>
        ))}
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

      {isLoading && !data && (
        <Card className="p-6 text-center text-sm text-muted-foreground">Loading mound targets…</Card>
      )}

      {data && signals.length === 0 && (
        <Card className="p-8 text-center" data-testid="empty-mound-radar">
          <Target className="w-8 h-8 mx-auto mb-2 text-muted-foreground/50" />
          <p className="text-sm font-medium">Waiting for probable starters.</p>
          <p className="text-xs text-muted-foreground mt-1">
            {view === "all"
              ? "Starters appear once today's probable pitchers are announced."
              : "Targets appear once probable starters are announced and a setup qualifies."}
          </p>
        </Card>
      )}

      <div className="grid gap-2.5">
        {signals.map((s) => (
          <MoundCard key={s.signalId} signal={s} showFade={view === "all"} />
        ))}
      </div>
    </div>
  );
}

// "Fade Candidate" is a presentation-only re-label of the existing "track"
// tier (score10 < 4.0) — already the composite of weak pitcherSkill/
// opponentKProfile/workload scores (scoring.ts). No new threshold or score
// is introduced here; only shown in the All Starters view, never on the
// curated Targets feed.
const FADE_COLOR = "#f43f5e";
const FADE_GLOW = "rgba(244,63,94,0.28)";

function MoundCard({ signal: s, showFade = false }: { signal: MoundSignal; showFade?: boolean }) {
  const style = TIER_STYLE[s.tier];
  const TierIcon = s.tier === "nuclear" || s.tier === "elite" ? Flame : s.tier === "strong" ? Zap : Target;
  const positives = s.drivers.filter((d) => d.direction === "positive").slice(0, 4);
  const negatives = s.drivers.filter((d) => d.direction === "negative").slice(0, 4);
  const isLocked = s.status === "locked";
  // "track" is also assigned when composeMoundScore caps a row for missing
  // data (e.g. pitcherSkillScore unavailable forces a 3.9 cap regardless of
  // the real composite) — require real pitcher-skill data behind the score
  // before calling it a genuine weak-matchup Fade Candidate, not a
  // missing-data artifact.
  const isFade = showFade && s.tier === "track" && s.diagnostics.pitcherSkillScore != null;

  const cashed = s.outcomes?.outcome === "mound_win" && s.outcomes?.userVisible === true;
  const cashedColor = "#10b981";
  const accentColor = cashed ? cashedColor : isFade ? FADE_COLOR : style.color;

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
        </div>
        <div className="text-right shrink-0">
          <div className="text-xl font-extrabold tabular-nums" style={{ color: accentColor }}>
            {s.score10.toFixed(1)}
          </div>
          <div
            className="inline-flex items-center gap-1 text-[10px] font-semibold"
            style={{ color: accentColor }}
          >
            {cashed ? <PartyPopper className="w-3 h-3" /> : isFade ? <ShieldAlert className="w-3 h-3" /> : <TierIcon className="w-3 h-3" />}
            {cashed ? "Cashed" : isFade ? "Fade Candidate" : style.label}
          </div>
        </div>
      </div>

      <RunEnvironmentRow park={s.parkContext} />
      <StrikeoutLineRow projectedStrikeouts={s.projectedStrikeouts} edge={s.marketEdgeContext} />

      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
        {marketSetups.map((setup) => (
          <Badge
            key={setup.market}
            variant="secondary"
            className={`text-[10px] px-1.5 py-0 ${setup.isPrimary ? "bg-amber-500/20 text-amber-200" : ""}`}
          >
            {MARKET_EMOJI[setup.market]} {MARKET_LABEL[setup.market]}
            {setup.setupLabel ? ` · ${setup.setupLabel}` : ""}
          </Badge>
        ))}
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

// Server-computed strikeout line context (see server MoundSignal). Omitted
// entirely when neither value is available — never a placeholder, matching
// this file's "missing data degrades to omitted" convention.
function StrikeoutLineRow({
  projectedStrikeouts,
  edge,
}: {
  projectedStrikeouts?: number | null;
  edge?: MoundMarketEdgeContext | null;
}) {
  if (projectedStrikeouts == null && !edge) return null;

  return (
    <div className="flex items-center gap-1.5 mt-1.5 text-[11px] flex-wrap" data-testid="mound-strikeout-line">
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
