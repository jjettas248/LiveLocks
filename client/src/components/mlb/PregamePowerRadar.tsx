// MLB Pre-Game Power Radar — user-facing surface.
//
// Renders server-stamped pre-game targets (score / tier / drivers verbatim).
// NO client-side scoring or tier derivation. Confirmed-lineup targets only
// (the server already filters). Language is "Pre-Game Target / Power Setup" —
// never "Lock / Guaranteed / Fire".

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Flame, Zap, Target, Wind, ShieldAlert, Lock } from "lucide-react";

type Tier = "track" | "watch" | "strong" | "elite" | "nuclear";
type Market = "home_runs" | "total_bases" | "hits" | "rbi" | "hrr";

interface PowerDriver {
  key: string;
  label: string;
  direction: "positive" | "negative" | "neutral";
  evidence?: string;
}

interface PregameSignal {
  signalId: string;
  gameId: string;
  startsAt: string | null;
  batterName: string;
  team: string;
  opponent: string;
  pitcherName: string | null;
  battingOrderSlot: number | null;
  handednessMatchup: string | null;
  primaryMarket: Market;
  marketTags: Market[];
  marketScores: Partial<Record<Market, number>>;
  score10: number;
  tier: Tier;
  drivers: PowerDriver[];
  status: "active" | "locked" | "expired" | "graded";
  gameStatus: string;
  lineupStatus: string;
  becameLiveReady?: boolean;
  becameLiveFire?: boolean;
}

interface RadarResponse {
  date: string;
  buildId: string;
  generatedAt: string;
  source: string;
  gamesScanned: number;
  signals: PregameSignal[];
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
  home_runs: "HR",
  total_bases: "Total Bases",
  hits: "Hits",
  rbi: "RBI",
  hrr: "HRR",
};

type FilterKey = "all" | "hr" | "tb" | "elite" | "confirmed" | "park" | "pitcher";
const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "hr", label: "HR" },
  { key: "tb", label: "Total Bases" },
  { key: "elite", label: "Elite+" },
  { key: "confirmed", label: "Confirmed Lineups" },
  { key: "park", label: "Park Boost" },
  { key: "pitcher", label: "Pitcher Vulnerability" },
];

function hasDriver(s: PregameSignal, predicate: (d: PowerDriver) => boolean): boolean {
  return s.drivers.some((d) => d.direction === "positive" && predicate(d));
}

export function PregamePowerRadar() {
  const [filter, setFilter] = useState<FilterKey>("all");

  const { data, isLoading } = useQuery<RadarResponse>({
    queryKey: ["/api/mlb/pregame-power-radar"],
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });

  const signals = useMemo(() => {
    const all = data?.signals ?? [];
    return all.filter((s) => {
      switch (filter) {
        case "hr": return s.marketTags.includes("home_runs");
        case "tb": return s.marketTags.includes("total_bases");
        case "elite": return s.tier === "elite" || s.tier === "nuclear";
        case "confirmed": return s.lineupStatus === "confirmed";
        case "park": return hasDriver(s, (d) => d.key.startsWith("pw_park") || d.key === "pw_wind_out" || d.key === "pw_temp");
        case "pitcher": return hasDriver(s, (d) => d.key.startsWith("pv_"));
        default: return true;
      }
    });
  }, [data, filter]);

  return (
    <div className="space-y-3" data-testid="section-pregame-power-radar">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Target className="w-5 h-5 text-amber-400" />
            Pre-Game Power Radar
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Pre-game targets from today's confirmed lineups — power setups, not guarantees.
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
            data-testid={`filter-pregame-${f.key}`}
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

      {isLoading && !data && (
        <Card className="p-6 text-center text-sm text-muted-foreground">Loading pre-game targets…</Card>
      )}

      {data && signals.length === 0 && (
        <Card className="p-8 text-center" data-testid="empty-pregame-power">
          <Target className="w-8 h-8 mx-auto mb-2 text-muted-foreground/50" />
          <p className="text-sm font-medium">Waiting for confirmed lineups.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Targets appear once official lineups are posted and a power setup qualifies.
          </p>
        </Card>
      )}

      <div className="grid gap-2.5">
        {signals.map((s) => (
          <PregameCard key={s.signalId} signal={s} />
        ))}
      </div>
    </div>
  );
}

function PregameCard({ signal: s }: { signal: PregameSignal }) {
  const style = TIER_STYLE[s.tier];
  const TierIcon = s.tier === "nuclear" || s.tier === "elite" ? Flame : s.tier === "strong" ? Zap : Target;
  const positives = s.drivers.filter((d) => d.direction === "positive").slice(0, 4);
  const isLocked = s.status === "locked";

  return (
    <Card
      className="p-3.5"
      style={{ boxShadow: `0 0 14px ${style.glow}`, borderColor: style.color + "55" }}
      data-testid={`card-pregame-${s.batterName.replace(/\s+/g, "-").toLowerCase()}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-sm truncate">{s.batterName}</span>
            <span className="text-[11px] text-muted-foreground">
              {s.team} vs {s.opponent}
            </span>
            {s.battingOrderSlot != null && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">#{s.battingOrderSlot}</Badge>
            )}
            {isLocked && (
              <span className="inline-flex items-center gap-1 text-[10px] text-amber-300/90">
                <Lock className="w-3 h-3" /> Locked at first pitch
              </span>
            )}
            {s.becameLiveFire ? (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-red-400">
                <Flame className="w-3 h-3" /> Pre-game target now live FIRE
              </span>
            ) : s.becameLiveReady ? (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-red-300">
                <Flame className="w-3 h-3" /> Pre-game target now live-ready
              </span>
            ) : null}
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            {s.pitcherName ? `vs ${s.pitcherName}` : "Pitcher TBD"}
            {s.handednessMatchup ? ` · ${s.handednessMatchup}` : ""}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-xl font-extrabold tabular-nums" style={{ color: style.color }}>
            {s.score10.toFixed(1)}
          </div>
          <div className="inline-flex items-center gap-1 text-[10px] font-semibold" style={{ color: style.color }}>
            <TierIcon className="w-3 h-3" /> {style.label}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
        {s.marketTags.map((m) => (
          <Badge
            key={m}
            variant="secondary"
            className={`text-[10px] px-1.5 py-0 ${m === s.primaryMarket ? "bg-amber-500/20 text-amber-200" : ""}`}
          >
            {MARKET_LABEL[m]}
            {s.marketScores[m] != null ? ` ${s.marketScores[m]!.toFixed(1)}` : ""}
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
              {d.key.startsWith("pw_wind") ? <Wind className="w-3 h-3" /> : d.key.startsWith("pv_") ? <ShieldAlert className="w-3 h-3" /> : null}
              {d.label}
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}

export default PregamePowerRadar;
