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
import {
  getPlateTagPresentation,
  getPlateToneClasses,
  getBvpPresentation,
  resolveMarketFitPresentation,
  getCarryPresentation,
  getWeatherSecondaryPresentations,
  getGradeFactorTone,
  type PlateTagTone,
} from "@/lib/mlb/plateTagPresentation";

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
  totalBases?: number | null;
  outcome?: "pregame_win" | "calibration_miss";
  userVisible?: boolean;
  hrInning?: number | null;
  hrHalf?: "top" | "bottom" | null;
}

// Display-only raw power-profile snapshot (server: PregamePowerProfileSnapshot).
// Frozen into the locked pregame signal. `pullRatePct` is RAW pull rate — always
// labeled "Pull Rate", never "Pull-Air"/"Pull-Side Power". Every field optional so
// older rehydrated rows render "Power profile unavailable" without individual
// below-threshold values being mislabeled as unavailable.
interface PowerProfileSnapshot {
  xISO?: number | null;
  hrFBRatioPct?: number | null;
  barrelRatePct?: number | null;
  hardHitRatePct?: number | null;
  maxEV?: number | null;
  pullRatePct?: number | null;
}

// Compact-card "Grade Factors" entry (see server/mlb/pregamePowerRadar/
// gradeFactorSummary.ts GradeFactorEntry). Server-owned, frozen at build time —
// rendered verbatim; the client never recomputes impact/selection/direction.
interface GradeFactorEntry {
  key: string;
  label: string;
  value: number;
  direction: "positive" | "negative" | "neutral";
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
  /** Optional — absent on older/rehydrated diagnostics snapshots. */
  bvpHits?: number | null;
  bvpDirection: "positive" | "neutral" | "negative";
  pitcherOrderSplitDirection: "vulnerable" | "neutral" | "suppressive" | "unavailable";
  batterOrderSplitDirection: "strong" | "neutral" | "weak" | "unavailable";
  batterCurrentOrderSlot: number | null;
  /** Display-only raw power-profile snapshot — absent on older rehydrated rows. */
  powerProfile?: PowerProfileSnapshot;
  /**
   * Compact-card "Grade Factors" — absent/null on legacy rows or when Pitcher
   * Vulnerability's own data isn't available. Render nothing in that case;
   * never backfill from other diagnostics fields.
   */
  gradeFactorSummary?: GradeFactorEntry[] | null;
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

/**
 * Shared by the compact market-fit chips and the expanded "Best Angle"/"Market
 * Fit" sections so they can never disagree. Prefers server-stamped qualitative
 * setups; falls back to bare market tags (no qualitative label, no raw score)
 * for older payloads — never computes a tier here.
 */
function resolveMarketSetups(s: PregameSignal): MarketSetup[] {
  return s.marketSetups && s.marketSetups.length > 0
    ? s.marketSetups
    : s.marketTags.map((m) => ({
        market: m,
        setupScore: s.marketScores[m] ?? 0,
        setupLabel: undefined as unknown as SetupLabel,
        isPrimary: m === s.primaryMarket,
      }));
}

/**
 * Best Angle fit word — the server-owned primary market's OWN fit tier
 * (Elite/Strong/Solid). A Watch-tier (or legacy-absent) primary returns null so
 * the market renders alone (bare), never a contradictory "Not Qualified".
 * primaryMarket itself is never suppressed/promoted/re-derived here.
 */
function primaryFitWordFor(marketSetups: MarketSetup[]): string | null {
  const primarySetup = marketSetups.find((m) => m.isPrimary);
  return primarySetup?.setupLabel === "Elite" ? "Elite Fit"
    : primarySetup?.setupLabel === "Strong" ? "Strong Fit"
    : primarySetup?.setupLabel === "Solid" ? "Solid Fit"
    : null;
}

/** Single resolver every driver-rendering call site uses (compact positives/negatives
 * rows, "Why We Like Him" list) so they can never disagree with each other or with the
 * expanded BvP row. For fit_bvp/fit_bvp_bad, both tone AND label come from
 * getBvpPresentation (confidence-aware — never the server's static driver.label,
 * which doesn't encode sample-size banding). Every other driver renders its own
 * server-owned label verbatim. */
function getDriverPresentation(
  driver: PowerDriver,
  diagnostics: PregameDiagnostics,
): { tone: PlateTagTone; label: string; classes: string } {
  if (driver.key === "fit_bvp" || driver.key === "fit_bvp_bad") {
    const bvp = getBvpPresentation(diagnostics);
    if (bvp) return { tone: bvp.tone, label: bvp.label, classes: bvp.classes };
  }
  const p = getPlateTagPresentation(driver.key, driver.direction);
  return { tone: p.tone, label: driver.label, classes: p.classes };
}

function hasDriver(s: PregameSignal, predicate: (d: PowerDriver) => boolean): boolean {
  return s.drivers.some((d) => d.direction === "positive" && predicate(d));
}

function PlateTagColorKey() {
  return (
    <details className="text-xs text-muted-foreground" data-testid="pregame-tag-color-key">
      <summary className="cursor-pointer select-none text-[11px] font-semibold hover:text-foreground">
        ⓘ Tag Color Key
      </summary>

      <div className="mt-2 grid gap-1.5 rounded-lg border border-border/30 bg-secondary/20 p-2 text-[11px]">
        <div>
          <span className="font-semibold text-emerald-300">Standout</span>
          {" = Exceptional, high-value advantage"}
        </div>
        <div>
          <span className="font-semibold text-amber-300">Supporting</span>
          {" = Useful supporting evidence, not the strongest signal"}
        </div>
        <div>
          <span className="font-semibold text-sky-300">Context</span>
          {" = Projection, limited evidence, or informational context"}
        </div>
        <div>
          <span className="font-semibold text-orange-300">Attack</span>
          {" = Favorable pitcher-vulnerability/attack condition (Grade Factors row) — distinct from Supporting"}
        </div>
        <div>
          <span className="font-semibold text-rose-300">Risk</span>
          {" = Negative or suppressive condition"}
        </div>
        <div>
          <span className="font-semibold text-muted-foreground">Neutral</span>
          {" = No meaningful directional effect, or data unavailable"}
        </div>
        <div className="pt-1 text-muted-foreground/80">
          The letter grade and setup tier badge (top-right of each card) use their own tier styling and are separate from these tag colors.
        </div>
      </div>
    </details>
  );
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

      <PlateTagColorKey />

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
  // Sort standout tags before supporting/context so they aren't crowded out
  // by the 4-tag cap when a card has more than 4 positive drivers. No driver
  // currently resolves to "attack" (that tone is Grade-Factors-only, rendered
  // via a separate path below) — ranked alongside "supporting" so the record
  // stays exhaustive if one ever does.
  const TONE_RANK: Record<PlateTagTone, number> = { standout: 0, supporting: 1, attack: 1, context: 2, risk: 3, neutral: 4 };
  // Pull is surfaced as its own dedicated "Pull Rate: X%" value below (never a
  // "Pull-Side Power" chip), so it's excluded from the 4-chip candidates — this
  // keeps a qualifying pull metric from being crowded off by the cap WITHOUT
  // reordering or dropping any other driver. The remaining chips keep their
  // existing order and 4-cap; overflow is surfaced as "+N more".
  const positiveDriversAll = s.drivers.filter((d) => d.direction === "positive" && d.key !== "power_pullair");
  const positives = positiveDriversAll
    .slice()
    .sort((a, b) => TONE_RANK[getDriverPresentation(a, s.diagnostics).tone] - TONE_RANK[getDriverPresentation(b, s.diagnostics).tone])
    .slice(0, 4);
  const hiddenPositiveCount = Math.max(0, positiveDriversAll.length - positives.length);
  const negatives = s.drivers.filter((d) => d.direction === "negative").slice(0, 4);
  const isLocked = s.status === "locked";
  const [expanded, setExpanded] = useState(false);
  const slug = s.batterName.replace(/\s+/g, "-").toLowerCase();

  // Dedicated raw pull-rate value — shown only when the engine already emitted
  // the qualifying `power_pullair` driver (sPull >= 7), on ANY Plate card
  // regardless of HR vs TB primary. Value from the frozen powerProfile snapshot,
  // falling back to the driver's "pull% X" evidence for older rehydrated rows.
  // A below-threshold pull rate (no driver fired) is never shown as a signal.
  const pullDriver = s.drivers.find((d) => d.key === "power_pullair");
  const pullRateValue = (() => {
    const pp = s.diagnostics.powerProfile?.pullRatePct;
    if (pp != null) return Math.round(pp);
    const m = pullDriver?.evidence?.match(/pull%\s*([\d.]+)/i);
    return m ? Math.round(parseFloat(m[1])) : null;
  })();
  const showPullRate = pullDriver != null && pullRateValue != null;

  // Market-aware final state — server-stamped outcomes only; the card never
  // derives win/loss. A cashed-HR celebration shows ONLY when HR is the primary
  // angle. A Total-Bases-primary card shows its final TB count instead (TB has
  // no stored line → never a cash/miss). HR-primary misses show a plain factual
  // "No HR" — shown, not erased.
  const isHrPrimary = s.primaryMarket === "home_runs";
  const hitHr = isHrPrimary && s.outcomes?.hitHr === true;
  const noHr = isHrPrimary && s.outcomes != null && s.outcomes.hitHr === false;
  const finalTotalBases = !isHrPrimary && s.outcomes != null ? (s.outcomes.totalBases ?? null) : null;
  const cashedColor = "#10b981";

  const edge = s.marketEdgeContext;
  const hasOdds = edge != null && edge.odds != null && edge.sportsbook;

  // Market-fit chips (compact card) — sorted primary-first so "Best Angle" is
  // always the leading chip, matching the market this card's grade is built for.
  const marketSetups: MarketSetup[] = resolveMarketSetups(s);
  const sortedMarketSetups = marketSetups.slice().sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0));

  const gradeFactors = s.diagnostics.gradeFactorSummary;

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
            {noHr && (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-semibold text-muted-foreground"
                data-testid={`pregame-nohr-${slug}`}
              >
                No HR
              </span>
            )}
            {finalTotalBases != null && (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-semibold text-sky-300"
                data-testid={`pregame-total-bases-${slug}`}
              >
                Total Bases: {finalTotalBases}
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
          {/* Market-fit chips — server-owned marketSetups rendered verbatim,
              primary first. Replaces the compact "Best Angle" sentence (moved
              to expanded details); the full HR/TB comparison still lives there. */}
          <div className="flex flex-col items-end gap-0.5 mt-1" data-testid={`pregame-market-fit-chips-${slug}`}>
            {sortedMarketSetups.map((setup) => {
              const pres = resolveMarketFitPresentation(setup.setupLabel ?? null);
              return (
                <span
                  key={setup.market}
                  className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md border ${pres ? pres.classes : getPlateToneClasses("neutral")}`}
                >
                  {setup.isPrimary ? MARKET_EMOJI[setup.market] : null} {MARKET_LABEL[setup.market]} • {pres ? pres.displayLabel : "Unavailable"}
                </span>
              );
            })}
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

      {/* Grade Factors — server-stamped, frozen at build time (see
          server/mlb/pregamePowerRadar/gradeFactorSummary.ts). Always Pitcher
          Vulnerability plus up to two more components/score-adjustments picked
          by largest realized impact on the grade. Rendered verbatim — no
          client-side selection, weighting, or tone re-derivation beyond the
          server-stamped `direction`. Absent on legacy rows or when Pitcher
          Vulnerability's own data is unavailable — renders nothing then. */}
      {gradeFactors && gradeFactors.length > 0 && (
        <div className="flex items-center gap-1.5 mt-2 flex-wrap" data-testid={`pregame-grade-factors-${slug}`}>
          {gradeFactors.map((f) => (
            <span
              key={f.key}
              className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md border ${getPlateToneClasses(getGradeFactorTone(f.direction))}`}
            >
              {f.label} • {f.value.toFixed(1)}
            </span>
          ))}
        </div>
      )}

      {/* Park / weather context — primary carry pill + secondary directional pills.
          Carry/weather driver classification is server-stamped; this row only formats it. */}
      <ParkConditionsRow park={s.parkContext} drivers={s.drivers} />

      {/* Player-specific park/wind fit (PR2) — server-stamped display/explainability,
          renders verbatim. Never a numeric score; the letter grade above stays the headline. */}
      <PlayerParkWindFitRow
        fit={s.playerParkWindFit}
        batterName={s.batterName}
        carryKnown={s.parkContext != null && s.parkContext.carryType !== "unknown"}
      />

      {/* Dedicated raw pull-rate value — separate from the 4-chip cap so a
          qualifying pull metric is never crowded off. Raw pull rate only; never
          labeled "Pull-Air"/"Pull-Side Power". */}
      {showPullRate && (
        <div className="mt-2">
          <span
            className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md border ${getPlateToneClasses("supporting")}`}
            data-testid={`pregame-pull-rate-${slug}`}
          >
            Pull Rate: {pullRateValue}%
          </span>
        </div>
      )}

      {positives.length > 0 && (
        <div className="flex items-start gap-1.5 mt-2 flex-wrap">
          {positives.map((d) => {
            const p = getDriverPresentation(d, s.diagnostics);
            return (
              <span
                key={d.key}
                className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md border ${p.classes}`}
                title={d.evidence}
              >
                {d.key.startsWith("pw_wind") ? <Wind className="w-3 h-3" /> : d.key.startsWith("pv_") ? <ShieldAlert className="w-3 h-3" /> : null}
                {p.label}
              </span>
            );
          })}
          {hiddenPositiveCount > 0 && (
            <span
              className={`inline-flex items-center text-[10px] px-2 py-0.5 rounded-md border ${getPlateToneClasses("neutral")}`}
              data-testid={`pregame-more-drivers-${slug}`}
            >
              +{hiddenPositiveCount} more
            </span>
          )}
        </div>
      )}

      {negatives.length > 0 && (
        <div className="flex items-start gap-1.5 mt-2 flex-wrap" data-testid={`pregame-warnings-${s.batterName.replace(/\s+/g, "-").toLowerCase()}`}>
          {negatives.map((d) => {
            const p = getDriverPresentation(d, s.diagnostics);
            return (
              <span
                key={d.key}
                className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md border ${p.classes}`}
                title={d.evidence}
              >
                <ShieldAlert className="w-3 h-3" />
                {p.label}
              </span>
            );
          })}
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

// Environment row: venue name + a visually dominant primary carry pill, followed
// by smaller secondary pills for temperature/wind/roof. Renders ONLY server-stamped
// parkContext fields plus tone classification driven by the driver array — no
// client-side carry/wind math. Wraps on mobile.
function ParkConditionsRow({ park, drivers }: { park?: ParkContext | null; drivers: PowerDriver[] }) {
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

  const carry = getCarryPresentation(park);
  const secondaryPills = getWeatherSecondaryPresentations(park, drivers);

  return (
    <div
      className="flex items-center gap-1.5 mt-1.5 text-[11px] flex-wrap"
      data-testid="pregame-park-conditions"
      title={park.driverText ?? undefined}
    >
      {park.venueName && <span className="text-muted-foreground">🏟️ {park.venueName}</span>}
      <Badge
        variant="secondary"
        className={`text-[10px] px-2 py-0.5 border font-bold ${carry.classes}`}
        data-testid="pregame-park-carry-primary"
      >
        {carry.emoji} {carry.label}
      </Badge>
      {secondaryPills.map((pill, i) => (
        <span
          key={i}
          className={`inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-md border ${pill.classes}`}
        >
          {pill.text.includes("mph") && <Wind className="w-3 h-3" />}
          {pill.text}
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
const FIT_TONE: Record<NonNullable<PlayerParkWindFit["classification"]>, PlateTagTone> = {
  boost: "supporting",
  suppress: "risk",
  neutral: "context",
  unknown: "neutral",
};

function PlayerParkWindFitRow({
  fit,
  batterName,
  carryKnown = false,
}: {
  fit?: PlayerParkWindFit | null;
  batterName: string;
  carryKnown?: boolean;
}) {
  const testid = `pregame-park-wind-fit-${batterName.replace(/\s+/g, "-").toLowerCase()}`;
  if (!fit) {
    const text = carryKnown
      ? "❔ Player-specific fit unavailable (batter handedness unknown) — park carry above is independent"
      : "❔ Park/wind data unavailable";
    return (
      <div
        className="flex items-center gap-1.5 mt-1.5 text-[11px] text-muted-foreground/70 italic flex-wrap"
        data-testid={`${testid}-unavailable`}
      >
        <span>{text}</span>
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-x-2 gap-y-1 mt-1.5 text-[11px] flex-wrap"
      data-testid={testid}
      title={fit.explanation}
    >
      <span className={`inline-flex items-center gap-1 font-semibold ${getPlateToneClasses(FIT_TONE[fit.classification])}`}>
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
  // Exclude power_pullair — raw pull rate is shown truthfully as "Pull Rate" in
  // the compact value + the Core Power Profile below; it must never render via
  // its server driver label "Pull-Side Power" (not a true pulled-air metric).
  const allPositives = s.drivers.filter((d) => d.direction === "positive" && d.key !== "power_pullair");
  const coverage = coverageLabel(diag.dataCoverageScore);
  const components = COMPONENT_LABELS
    .map(({ key, label }) => ({ label, value: diag[key] as number | null | undefined }))
    .filter((c): c is { label: string; value: number } => c.value != null);
  const hasMatchupContext =
    diag.bvpAvailable ||
    diag.pitcherOrderSplitDirection !== "unavailable" ||
    diag.batterOrderSplitDirection !== "unavailable";
  // Best Angle sentence — moved here from the compact card face (now shown as
  // market-fit chips instead); same shared helpers so the two views can never
  // disagree. The full HR/TB comparison is the "Market Fit" section below.
  const marketSetups = resolveMarketSetups(s);
  const primaryFitWord = primaryFitWordFor(marketSetups);
  const slug = s.batterName.replace(/\s+/g, "-").toLowerCase();

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2.5">
        <PlayerAvatar id={s.batterId} name={s.batterName} />
        <div className="flex-1 min-w-0">
          <SetupMeter score10={s.score10} tier={s.tier} />
        </div>
      </div>

      {BEST_ANGLE_LABEL[s.primaryMarket] && (
        <div className="text-[10px] text-muted-foreground/80" data-testid={`pregame-best-angle-${slug}`}>
          Best Angle: {BEST_ANGLE_LABEL[s.primaryMarket]}{primaryFitWord ? ` — ${primaryFitWord}` : ""}
        </div>
      )}

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
            {allPositives.map((d) => {
              const p = getDriverPresentation(d, diag);
              return (
                <li key={d.key} className="flex items-start gap-1.5 text-[10px] text-foreground/90 leading-snug">
                  <Check className={`w-3 h-3 shrink-0 mt-0.5 rounded-sm ${getPlateToneClasses(p.tone)}`} />
                  <span>
                    {p.label}
                    {d.evidence ? <span className="text-muted-foreground"> — {d.evidence}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {hasMatchupContext && (
        <div className="rounded-lg p-2.5 bg-secondary/20 border border-border/20 space-y-1 text-[10px]">
          <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Matchup Context</div>
          {(() => {
            const bvp = getBvpPresentation(diag);
            if (!bvp) return null;
            return (
              <div className="flex justify-between">
                <span className="text-muted-foreground">BvP History</span>
                <span className={`font-semibold px-1.5 py-0.5 rounded border ${bvp.classes}`}>{bvp.label}</span>
              </div>
            );
          })()}
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

      {(() => {
        // "Poor BvP History" duplicates the resolved BvP row above (Matchup
        // Context) once it's available — suppress the coarser string so the
        // card never shows two different BvP descriptions at once.
        const visibleWarningTags = diag.warningTags.filter(
          (t) => !(t === "Poor BvP History" && diag.bvpAvailable),
        );
        if (visibleWarningTags.length === 0) return null;
        return (
          <div className="flex items-start gap-1.5 flex-wrap">
            {visibleWarningTags.map((t) => {
              const p = getPlateTagPresentation(t, "negative");
              return (
                <span
                  key={t}
                  className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md border ${p.classes}`}
                >
                  <ShieldAlert className="w-3 h-3" /> {t}
                </span>
              );
            })}
          </div>
        );
      })()}

      {/* Market Fit comparison — matchup/model-fit classifications, NOT bets.
          Rendered from the server-stamped setup labels (never re-derived). A
          market below the Solid threshold reads "Below Solid". */}
      <div className="rounded-lg p-2.5 bg-secondary/20 border border-border/20 space-y-1 text-[10px]" data-testid={`pregame-market-fit-${s.batterName.replace(/\s+/g, "-").toLowerCase()}`}>
        <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Market Fit</div>
        {([["home_runs", "Home Run Fit"], ["total_bases", "Total Bases Fit"]] as const).map(([market, label]) => {
          const setup = s.marketSetups?.find((m) => m.market === market);
          // Server-stamped setupLabel ONLY — never fabricate a fit from a raw
          // score. Absent label → "unavailable" (not a made-up "Below Solid").
          const pres = resolveMarketFitPresentation(setup?.setupLabel ?? null);
          return (
            <div key={market} className="flex justify-between items-center">
              <span className="text-muted-foreground">{label}</span>
              {pres ? (
                <span className={`font-semibold px-1.5 py-0.5 rounded border ${pres.classes}`}>{pres.displayLabel}</span>
              ) : (
                <span className="text-muted-foreground/70">unavailable</span>
              )}
            </div>
          );
        })}
        <div className="pt-1 text-[9px] text-muted-foreground/80 leading-snug">
          Market fit is a matchup/model classification — not an official bet or sportsbook-line prediction.
        </div>
      </div>

      {/* Core Power Profile — raw hitter inputs (display-only snapshot). Missing
          values read "unavailable"; a below-threshold value is a real number, not
          unavailable. `Pull Rate` is raw pull rate, never "Pull-Air". */}
      {(() => {
        const pp = s.diagnostics.powerProfile;
        const fmt = (v: number | null | undefined, kind: "iso" | "pct" | "mph") =>
          v == null ? "unavailable"
          : kind === "iso" ? v.toFixed(3)
          : kind === "pct" ? `${v.toFixed(1)}%`
          : `${Math.round(v)} mph`;
        const rows: Array<{ label: string; value: number | null | undefined; kind: "iso" | "pct" | "mph" }> = [
          { label: "xISO", value: pp?.xISO, kind: "iso" },
          { label: "HR/FB", value: pp?.hrFBRatioPct, kind: "pct" },
          { label: "Barrel Rate", value: pp?.barrelRatePct, kind: "pct" },
          { label: "Hard-Hit Rate", value: pp?.hardHitRatePct, kind: "pct" },
          { label: "Max Exit Velo", value: pp?.maxEV, kind: "mph" },
          { label: "Pull Rate", value: pp?.pullRatePct, kind: "pct" },
        ];
        return (
          <div className="rounded-lg p-2.5 bg-secondary/20 border border-border/20 space-y-1 text-[10px]" data-testid={`pregame-power-profile-${s.batterName.replace(/\s+/g, "-").toLowerCase()}`}>
            <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Core Power Profile</div>
            {pp == null ? (
              <div className="text-muted-foreground/70">Power profile unavailable.</div>
            ) : (
              rows.map((r) => (
                <div key={r.label} className="flex justify-between items-center">
                  <span className="text-muted-foreground">{r.label}</span>
                  <span className={`font-semibold tabular-nums ${r.value == null ? "text-muted-foreground/70" : ""}`}>{fmt(r.value, r.kind)}</span>
                </div>
              ))
            )}
          </div>
        );
      })()}
    </div>
  );
}
