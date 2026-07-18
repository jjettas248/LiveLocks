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
import { Flame, Zap, Target, Wind, ShieldAlert, Lock, PartyPopper, Landmark, ChevronDown, ChevronUp, Check } from "lucide-react";
import { PregameHistoryDrawer } from "./PregameHistoryDrawer";
import { PregameRadarRecord } from "./PregameWinCard";
import { getSetupGrade } from "@/lib/mlb/setupGrade";

type Tier = "track" | "watch" | "power_watch" | "strong" | "elite" | "nuclear";
type Market = "home_runs" | "total_bases" | "hits" | "rbi" | "hrr";

interface PowerDriver {
  key: string;
  label: string;
  direction: "positive" | "negative" | "neutral";
  evidence?: string;
}

type SetupLabel = "Elite" | "Strong" | "Solid" | "Watch";

interface MarketSetup {
  market: Market;
  setupScore: number; // 0–10 — expanded/debug only, never shown on the compact chip
  setupLabel: SetupLabel;
  isPrimary: boolean;
}

interface ParkContext {
  venueName: string | null;
  temperatureF: number | null;
  windMph: number | null;
  windDirectionLabel: string | null;
  carryLabel:
    | "HR Carry"
    | "Carry Boost"
    | "Carry Suppressed"
    | "Neutral Air"
    | "Neutral Conditions"
    | "Conditions Unavailable";
  carryType: "boost" | "suppress" | "neutral" | "unknown";
  driverText?: string | null;
}

// Player-specific park/wind fit (PR2) — DISPLAY ONLY. Server-stamped by the
// shared parkWindFit module; the card renders these fields verbatim and never
// recomputes the fit. Carries no numeric model value.
interface PlayerParkWindFit {
  emoji: string;
  label: string;
  explanation: string;
  windDirectionLabel: string | null;
  windSpeedMph: number | null;
  classification: "boost" | "suppress" | "neutral" | "unknown";
  confidence: "high" | "medium" | "low" | "none";
}

// Best-odds display contract (PregameMarketEdgeContext on the server). Read-only,
// cache-sourced — never blends into score10. Renders verbatim when present.
interface MarketEdgeContext {
  line?: number | null;
  odds?: number | null;
  impliedProbability?: number | null;
  sportsbook?: string | null;
  oddsUpdatedAt?: string | null;
}

// Outcome/live-bridge fields — server-stamped, wins-only semantics mirrored
// from the Pregame Radar Win Attribution module. `hitHr` flips the card to a
// cashed visual treatment in real time as the 30s poll picks up the grade.
interface PregameOutcome {
  hitHr?: boolean;
  outcome?: "pregame_win" | "calibration_miss";
  userVisible?: boolean;
  hrInning?: number | null;
  hrHalf?: "top" | "bottom" | null;
}

// Diagnostics carried by the server-side PregamePowerSignal (see
// server/mlb/pregamePowerRadar/types.ts PregamePowerDiagnostics) and already
// returned verbatim by the public API — surfaced here for the expanded detail
// view only. Display-only: never re-derived, never fed back into score10.
interface PregameDiagnostics {
  batterPowerScore: number | null;
  pitcherVulnerabilityScore: number | null;
  matchupFitScore: number | null;
  parkWeatherScore: number | null;
  lineupOpportunityScore: number | null;
  nearHrRecentFormScore?: number | null;
  dataCoverageScore: number;
  warningTags: string[];
  bvpAvailable: boolean;
  bvpScore: number | null;
  bvpSampleSize: number | null;
  bvpDirection: "positive" | "neutral" | "negative";
  pitcherOrderSplitDirection: "vulnerable" | "neutral" | "suppressive" | "unavailable";
  batterOrderSplitDirection: "strong" | "neutral" | "weak" | "unavailable";
  batterCurrentOrderSlot: number | null;
}

interface PregameSignal {
  signalId: string;
  gameId: string;
  startsAt: string | null;
  batterId: string;
  batterName: string;
  team: string;
  opponent: string;
  pitcherId: string | null;
  pitcherName: string | null;
  battingOrderSlot: number | null;
  handednessMatchup: string | null;
  primaryMarket: Market;
  marketTags: Market[];
  marketScores: Partial<Record<Market, number>>;
  marketSetups?: MarketSetup[];
  parkContext?: ParkContext | null;
  playerParkWindFit?: PlayerParkWindFit | null;
  marketEdgeContext?: MarketEdgeContext | null;
  score10: number;
  tier: Tier;
  drivers: PowerDriver[];
  status: "active" | "locked" | "expired" | "graded";
  gameStatus: string;
  lineupStatus: string;
  becameLiveReady?: boolean;
  becameLiveFire?: boolean;
  outcomes?: PregameOutcome | null;
  diagnostics: PregameDiagnostics;
}

const SPORTSBOOK_LABELS: Record<string, string> = {
  draftkings: "DraftKings",
  fanduel: "FanDuel",
  betmgm: "BetMGM",
  caesars: "Caesars",
  pointsbetus: "PointsBet",
  hardrockbet: "Hard Rock",
  fanatics: "Fanatics",
  espnbet: "ESPN BET",
};

function formatAmericanOdds(odds: number): string {
  return odds > 0 ? `+${odds}` : `${odds}`;
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
  // Elite raw power, but the pitcher matchup does NOT support an elite setup.
  power_watch: { label: "Batter Power Only", color: "#38bdf8", glow: "rgba(56,189,248,0.18)" },
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

// Display-only emoji per market (formatting, not logic). HR-family → 🎯, contact → 📈.
const MARKET_EMOJI: Record<Market, string> = {
  home_runs: "🎯",
  total_bases: "📈",
  hits: "📈",
  rbi: "📈",
  hrr: "🎯",
};

// Carry label → emoji prefix. The label text itself is server-owned (parkContext);
// the client only picks the leading glyph + color from the server's carryType.
const CARRY_EMOJI: Record<ParkContext["carryLabel"], string> = {
  "HR Carry": "🔥",
  "Carry Boost": "🌬️",
  "Carry Suppressed": "🧊",
  "Neutral Air": "↔",
  "Neutral Conditions": "🏟️",
  "Conditions Unavailable": "🚫",
};

const CARRY_COLOR: Record<ParkContext["carryType"], string> = {
  boost: "text-amber-300",
  suppress: "text-sky-300",
  neutral: "text-muted-foreground",
  unknown: "text-muted-foreground/70 italic",
};

type FilterKey = "all" | "hr" | "tb" | "elite" | "confirmed" | "park" | "pitcher" | "risk";
const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "hr", label: "HR" },
  { key: "tb", label: "Total Bases" },
  { key: "elite", label: "Elite+" },
  { key: "confirmed", label: "Confirmed Lineups" },
  { key: "park", label: "Park Boost" },
  { key: "pitcher", label: "Pitcher Vulnerability" },
  { key: "risk", label: "Risk Warnings" },
];

/** Best Angle — pure display mapping of the existing server-stamped primaryMarket. Missing/unsupported markets render nothing (never inferred from drivers/score/tags/odds). */
const BEST_ANGLE_LABEL: Partial<Record<Market, string>> = {
  home_runs: "Home Run",
  total_bases: "Total Bases",
};

/** Plate-only chip color mapping for the existing server-provided marketSetups[].setupLabel. Watch/missing is neutral — never rose (rose is reserved for actual risk/caution states). No new thresholds; only maps the existing four labels to color. */
function getPlateSetupLabelClasses(label?: SetupLabel | null): string {
  switch (label) {
    case "Elite":
      return "bg-emerald-500/20 text-emerald-200 border-emerald-400/30";
    case "Strong":
      return "bg-green-500/20 text-green-200 border-green-400/30";
    case "Solid":
      return "bg-amber-500/20 text-amber-200 border-amber-400/30";
    case "Watch":
    default:
      return "bg-secondary text-muted-foreground border-border/40";
  }
}

function hasDriver(s: PregameSignal, predicate: (d: PowerDriver) => boolean): boolean {
  return s.drivers.some((d) => d.direction === "positive" && predicate(d));
}

export function PregamePowerRadar({ selectedGameId = null }: { selectedGameId?: string | null } = {}) {
  const [filter, setFilter] = useState<FilterKey>("all");

  const { data, isLoading } = useQuery<RadarResponse>({
    queryKey: ["/api/mlb/pregame-power-radar"],
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });

  const signals = useMemo(() => {
    const all = data?.signals ?? [];
    return all.filter((s) => {
      // Slate-ribbon deep-link filter — presentational only. No-op when null.
      if (selectedGameId && s.gameId !== selectedGameId) return false;
      switch (filter) {
        case "hr": return s.marketTags.includes("home_runs");
        case "tb": return s.marketTags.includes("total_bases");
        case "elite": return s.tier === "elite" || s.tier === "nuclear";
        case "confirmed": return s.lineupStatus === "posted";
        case "park": return hasDriver(s, (d) => d.key.startsWith("pw_park") || d.key === "pw_wind_out" || d.key === "pw_temp");
        case "pitcher": return hasDriver(s, (d) => d.key.startsWith("pv_"));
        case "risk": return s.drivers.some((d) => d.direction === "negative") || s.diagnostics.warningTags.length > 0;
        default: return true;
      }
    });
  }, [data, filter, selectedGameId]);

  return (
    <div className="space-y-3" data-testid="section-pregame-power-radar">
      <PregameHistoryDrawer />
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Target className="w-5 h-5 text-amber-400" />
            The Plate
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Hitter targets from today's confirmed lineups — power and production setups, not guarantees.
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

      <PregameRadarRecord />

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
  const negatives = s.drivers.filter((d) => d.direction === "negative").slice(0, 4);
  const isLocked = s.status === "locked";
  const [expanded, setExpanded] = useState(false);
  const slug = s.batterName.replace(/\s+/g, "-").toLowerCase();

  // Cashed HR — purely visual flip to a green "win" treatment. Server-stamped
  // outcome only (outcomes.hitHr); the card never derives win/loss itself.
  const hitHr = s.outcomes?.hitHr === true;
  const cashedColor = "#10b981";

  const edge = s.marketEdgeContext;
  const hasOdds = edge != null && edge.odds != null && edge.sportsbook;

  // Prefer server-stamped qualitative setups. Fall back to bare market tags (no
  // qualitative label, no raw score) for older payloads — never compute a tier here.
  const marketSetups: MarketSetup[] =
    s.marketSetups && s.marketSetups.length > 0
      ? s.marketSetups
      : s.marketTags.map((m) => ({
          market: m,
          setupScore: s.marketScores[m] ?? 0,
          setupLabel: undefined as unknown as SetupLabel,
          isPrimary: m === s.primaryMarket,
        }));

  return (
    <Card
      className={`p-3.5 transition-colors duration-500 ${hitHr ? "bg-emerald-500/10" : ""}`}
      style={{
        boxShadow: hitHr ? `0 0 22px rgba(16,185,129,0.45)` : `0 0 14px ${style.glow}`,
        borderColor: hitHr ? cashedColor + "99" : style.color + "55",
      }}
      data-testid={`card-pregame-${slug}`}
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
            <span className="font-bold text-sm truncate">{s.batterName}</span>
            <span className="text-[11px] text-muted-foreground">
              {s.team} vs {s.opponent}
            </span>
            {s.battingOrderSlot != null && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">#{s.battingOrderSlot}</Badge>
            )}
            {hitHr && (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-300 animate-pulse"
                data-testid={`pregame-cashed-${s.batterName.replace(/\s+/g, "-").toLowerCase()}`}
              >
                <PartyPopper className="w-3 h-3" /> HOMERED
                {s.outcomes?.hrInning != null
                  ? ` · ${s.outcomes.hrHalf === "top" ? "Top" : "Bot"} ${s.outcomes.hrInning}`
                  : ""}
              </span>
            )}
            {isLocked && !hitHr && (
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
          {BEST_ANGLE_LABEL[s.primaryMarket] && (
            <div className="text-[10px] text-muted-foreground/80 mt-0.5" data-testid={`pregame-best-angle-${slug}`}>
              Best Angle: {BEST_ANGLE_LABEL[s.primaryMarket]}
            </div>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="text-xl font-extrabold tabular-nums" style={{ color: hitHr ? cashedColor : style.color }}>
            {getSetupGrade(s.score10)}
          </div>
          <div
            className="inline-flex items-center gap-1 text-[10px] font-semibold"
            style={{ color: hitHr ? cashedColor : style.color }}
          >
            {hitHr ? <PartyPopper className="w-3 h-3" /> : <TierIcon className="w-3 h-3" />}
            {hitHr ? "Cashed" : style.label}
          </div>
          {hasOdds && (
            <div
              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground mt-1"
              title={edge.line != null ? `Line ${edge.line}` : undefined}
              data-testid={`pregame-best-odds-${s.batterName.replace(/\s+/g, "-").toLowerCase()}`}
            >
              <Landmark className="w-3 h-3" />
              {SPORTSBOOK_LABELS[edge!.sportsbook!.toLowerCase()] ?? edge!.sportsbook}
              <span className="font-semibold">{formatAmericanOdds(edge!.odds!)}</span>
            </div>
          )}
        </div>
      </div>

      {/* Park / weather context — secondary line, server-stamped, renders verbatim. */}
      <ParkConditionsRow park={s.parkContext} />

      {/* Player-specific park/wind fit (PR2) — server-stamped display/explainability,
          renders verbatim. Never a numeric score; the letter grade above stays the headline. */}
      <PlayerParkWindFitRow fit={s.playerParkWindFit} batterName={s.batterName} />

      {/* Market chips — qualitative setup labels only, color-coded by the existing
          server-provided setupLabel (Elite/Strong → green, Solid → amber,
          Watch/missing → neutral). Numeric setup scores are intentionally NOT shown
          here (compact face OR tooltip); they live in the admin/debug diagnostics views. */}
      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
        {marketSetups.map((setup) => (
          <Badge
            key={setup.market}
            variant="secondary"
            className={`text-[10px] px-1.5 py-0 border ${getPlateSetupLabelClasses(setup.setupLabel)} ${setup.isPrimary ? "font-bold" : ""}`}
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
              {d.key.startsWith("pw_wind") ? <Wind className="w-3 h-3" /> : d.key.startsWith("pv_") ? <ShieldAlert className="w-3 h-3" /> : null}
              {d.label}
            </span>
          ))}
        </div>
      )}

      {negatives.length > 0 && (
        <div className="flex items-start gap-1.5 mt-2 flex-wrap" data-testid={`pregame-warnings-${s.batterName.replace(/\s+/g, "-").toLowerCase()}`}>
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
          data-testid={`button-expand-pregame-${slug}`}
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
          data-testid={`pregame-expanded-${slug}`}
        >
          <PregameExpandedDetail signal={s} />
        </div>
      )}
    </Card>
  );
}

// Compact, visually-secondary park/weather context line. Renders ONLY the
// server-stamped parkContext fields — no client-side carry/wind inference, no raw
// weather-modifier values. One line on desktop; wraps on mobile.
function ParkConditionsRow({ park }: { park?: ParkContext | null }) {
  // `null`/absent parkContext means the server genuinely does NOT know the
  // conditions (e.g. DB-fallback path). Be honest — never imply neutral.
  if (!park) {
    return (
      <div
        className="flex items-center gap-1.5 mt-1.5 text-[11px] text-muted-foreground/70 italic flex-wrap"
        data-testid="pregame-park-conditions-unavailable"
      >
        <span>🏟️ Park context unavailable</span>
      </div>
    );
  }

  const hasContext =
    park.venueName != null || park.temperatureF != null || park.windMph != null;
  const carryIsMeaningful = park.carryType !== "neutral" || park.carryLabel !== "Neutral Conditions";
  // Nothing known and no meaningful carry call → hide rather than render an empty row.
  if (!hasContext && !carryIsMeaningful && park.carryType !== "unknown") return null;

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
    <span key="carry" className={`font-semibold ${CARRY_COLOR[park.carryType]}`}>
      {CARRY_EMOJI[park.carryLabel]} {park.carryLabel}
    </span>,
  );

  return (
    <div
      className="flex items-center gap-1.5 mt-1.5 text-[11px] text-muted-foreground flex-wrap"
      data-testid="pregame-park-conditions"
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

// Player-specific park/wind fit line (PR2). Renders ONLY server-stamped fields
// from the shared parkWindFit module — emoji + qualitative label + wind
// direction/speed + a short explanation. No client-side fit math, no numeric
// model value. Wraps cleanly on mobile (flex-wrap). When the fit is absent
// (DB-fallback path), shows an honest "data unavailable" fallback.
const FIT_COLOR: Record<NonNullable<PlayerParkWindFit["classification"]>, string> = {
  boost: "text-emerald-300",
  suppress: "text-rose-300",
  neutral: "text-muted-foreground",
  unknown: "text-muted-foreground/70",
};

function PlayerParkWindFitRow({ fit, batterName }: { fit?: PlayerParkWindFit | null; batterName: string }) {
  const testid = `pregame-park-wind-fit-${batterName.replace(/\s+/g, "-").toLowerCase()}`;
  if (!fit) {
    return (
      <div
        className="flex items-center gap-1.5 mt-1.5 text-[11px] text-muted-foreground/70 italic flex-wrap"
        data-testid={`${testid}-unavailable`}
      >
        <span>❔ Park/wind data unavailable</span>
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-x-2 gap-y-1 mt-1.5 text-[11px] flex-wrap"
      data-testid={testid}
      title={fit.explanation}
    >
      <span className={`inline-flex items-center gap-1 font-semibold ${FIT_COLOR[fit.classification]}`}>
        <span data-testid={`${testid}-emoji`}>{fit.emoji}</span>
        <span>{fit.label}</span>
      </span>
      {(fit.windDirectionLabel || fit.windSpeedMph != null) && (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <span className="opacity-40">·</span>
          <Wind className="w-3 h-3" />
          {fit.windDirectionLabel ?? "Wind"}
          {fit.windSpeedMph != null ? ` ${Math.round(fit.windSpeedMph)} mph` : ""}
        </span>
      )}
    </div>
  );
}

// ── Expanded detail view (click-to-expand) ──────────────────────────────────
// Everything below renders ONLY inside the expanded block — the collapsed
// card above is untouched. All values are server-stamped (diagnostics /
// drivers already on PregameSignal); nothing here re-derives score10 or tier.

function PlayerAvatar({ id, name, size = 40 }: { id: string | null; name: string; size?: number }) {
  const [errored, setErrored] = useState(false);
  const initials = name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  const testSlug = name.replace(/\s+/g, "-").toLowerCase();

  if (!id || errored) {
    return (
      <div
        className="rounded-full bg-secondary/60 border border-border/40 flex items-center justify-center font-bold text-muted-foreground shrink-0"
        style={{ width: size, height: size, fontSize: size * 0.36 }}
        data-testid={`avatar-initials-${testSlug}`}
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
      data-testid={`avatar-photo-${testSlug}`}
    />
  );
}

function SetupMeter({ score10, tier }: { score10: number; tier: Tier }) {
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

function componentBarColor(v: number): string {
  if (v >= 7) return "#22c55e";
  if (v >= 5) return "#eab308";
  return "#71717a";
}

function ComponentBar({ label, value }: { label: string; value: number }) {
  const pct = Math.max(0, Math.min(100, (value / 10) * 100));
  const color = componentBarColor(value);
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

function coverageLabel(v: number): { label: string; color: string } {
  if (v >= 0.8) return { label: "High", color: "#22c55e" };
  if (v >= 0.6) return { label: "Medium", color: "#eab308" };
  return { label: "Low", color: "#ef4444" };
}

const COMPONENT_LABELS: Array<{ key: keyof PregameDiagnostics; label: string }> = [
  { key: "batterPowerScore", label: "Batter Power" },
  { key: "pitcherVulnerabilityScore", label: "Pitcher Vulnerability" },
  { key: "matchupFitScore", label: "Matchup Fit" },
  { key: "parkWeatherScore", label: "Park & Weather" },
  { key: "lineupOpportunityScore", label: "Lineup Opportunity" },
  { key: "nearHrRecentFormScore", label: "Near-HR Recent Form" },
];

function PregameExpandedDetail({ signal: s }: { signal: PregameSignal }) {
  const diag = s.diagnostics;
  const allPositives = s.drivers.filter((d) => d.direction === "positive");
  const coverage = coverageLabel(diag.dataCoverageScore);
  const components = COMPONENT_LABELS
    .map(({ key, label }) => ({ label, value: diag[key] as number | null | undefined }))
    .filter((c): c is { label: string; value: number } => c.value != null);
  const hasMatchupContext =
    diag.bvpAvailable ||
    diag.pitcherOrderSplitDirection !== "unavailable" ||
    diag.batterOrderSplitDirection !== "unavailable";

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2.5">
        <PlayerAvatar id={s.batterId} name={s.batterName} />
        <div className="flex-1 min-w-0">
          <SetupMeter score10={s.score10} tier={s.tier} />
        </div>
      </div>

      {/* Raw numeric score — secondary information only. The letter grade on the
          compact card (getSetupGrade) remains the primary user-facing decision
          signal; this row exists for users who want the underlying number. */}
      <div className="flex items-center justify-between text-[9px]">
        <span className="text-muted-foreground uppercase tracking-wider font-bold">Raw Score</span>
        <span className="font-semibold text-muted-foreground" data-testid={`pregame-raw-score-${s.batterName.replace(/\s+/g, "-").toLowerCase()}`}>
          {s.score10.toFixed(1)} / 10
        </span>
      </div>

      <div className="flex items-center justify-between text-[9px]">
        <span className="text-muted-foreground uppercase tracking-wider font-bold">Data Coverage</span>
        <span className="font-semibold" style={{ color: coverage.color }}>{coverage.label}</span>
      </div>

      {components.length > 0 && (
        <div className="rounded-lg p-2.5 bg-secondary/20 border border-border/20 space-y-1">
          <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Setup Breakdown</div>
          {components.map((c) => (
            <ComponentBar key={c.label} label={c.label} value={c.value} />
          ))}
        </div>
      )}

      {allPositives.length > 0 && (
        <div className="rounded-lg p-2.5 bg-secondary/20 border border-border/20">
          <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">Why We Like Him</div>
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

      {hasMatchupContext && (
        <div className="rounded-lg p-2.5 bg-secondary/20 border border-border/20 space-y-1 text-[10px]">
          <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Matchup Context</div>
          {diag.bvpAvailable && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">BvP History</span>
              <span
                className="font-semibold capitalize"
                style={{
                  color:
                    diag.bvpDirection === "positive" ? "#22c55e" : diag.bvpDirection === "negative" ? "#ef4444" : "#a1a1aa",
                }}
              >
                {diag.bvpDirection}
                {diag.bvpSampleSize != null ? ` (${diag.bvpSampleSize} AB)` : ""}
              </span>
            </div>
          )}
          {diag.pitcherOrderSplitDirection !== "unavailable" && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Pitcher vs Slot</span>
              <span className="font-semibold capitalize">{diag.pitcherOrderSplitDirection}</span>
            </div>
          )}
          {diag.batterOrderSplitDirection !== "unavailable" && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">
                Batter From Slot{diag.batterCurrentOrderSlot != null ? ` #${diag.batterCurrentOrderSlot}` : ""}
              </span>
              <span className="font-semibold capitalize">{diag.batterOrderSplitDirection}</span>
            </div>
          )}
        </div>
      )}

      {diag.warningTags.length > 0 && (
        <div className="flex items-start gap-1.5 flex-wrap">
          {diag.warningTags.map((t) => (
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
