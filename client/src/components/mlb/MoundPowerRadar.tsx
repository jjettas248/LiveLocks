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
import { Flame, Zap, Target, Wind, ShieldAlert, Lock, PartyPopper } from "lucide-react";
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

interface MoundSignal {
  signalId: string;
  gameId: string;
  startsAt: string | null;
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

export function MoundPowerRadar({ selectedGameId = null }: { selectedGameId?: string | null } = {}) {
  const [filter, setFilter] = useState<FilterKey>("all");

  const { data, isLoading } = useQuery<MoundRadarResponse>({
    queryKey: ["/api/mlb/mound-power-radar"],
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });

  const signals = useMemo(() => {
    const all = data?.signals ?? [];
    return all.filter((s) => {
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
            <div>{data.diagnostics.publicSignals} targets · {data.gamesScanned} games</div>
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

      {isLoading && !data && (
        <Card className="p-6 text-center text-sm text-muted-foreground">Loading mound targets…</Card>
      )}

      {data && signals.length === 0 && (
        <Card className="p-8 text-center" data-testid="empty-mound-radar">
          <Target className="w-8 h-8 mx-auto mb-2 text-muted-foreground/50" />
          <p className="text-sm font-medium">Waiting for probable starters.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Targets appear once probable starters are announced and a setup qualifies.
          </p>
        </Card>
      )}

      <div className="grid gap-2.5">
        {signals.map((s) => (
          <MoundCard key={s.signalId} signal={s} />
        ))}
      </div>
    </div>
  );
}

function MoundCard({ signal: s }: { signal: MoundSignal }) {
  const style = TIER_STYLE[s.tier];
  const TierIcon = s.tier === "nuclear" || s.tier === "elite" ? Flame : s.tier === "strong" ? Zap : Target;
  const positives = s.drivers.filter((d) => d.direction === "positive").slice(0, 4);
  const negatives = s.drivers.filter((d) => d.direction === "negative").slice(0, 4);
  const isLocked = s.status === "locked";

  const cashed = s.outcomes?.outcome === "mound_win" && s.outcomes?.userVisible === true;
  const cashedColor = "#10b981";

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

  return (
    <Card
      className={`p-3.5 transition-colors duration-500 ${cashed ? "bg-emerald-500/10" : ""}`}
      style={{
        boxShadow: cashed ? `0 0 22px rgba(16,185,129,0.45)` : `0 0 14px ${style.glow}`,
        borderColor: cashed ? cashedColor + "99" : style.color + "55",
      }}
      data-testid={`card-mound-${slug}`}
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
          <div className="text-xl font-extrabold tabular-nums" style={{ color: cashed ? cashedColor : style.color }}>
            {s.score10.toFixed(1)}
          </div>
          <div
            className="inline-flex items-center gap-1 text-[10px] font-semibold"
            style={{ color: cashed ? cashedColor : style.color }}
          >
            {cashed ? <PartyPopper className="w-3 h-3" /> : <TierIcon className="w-3 h-3" />}
            {cashed ? "Cashed" : style.label}
          </div>
        </div>
      </div>

      <RunEnvironmentRow park={s.parkContext} />

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
    </Card>
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
