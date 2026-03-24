import { useState } from "react";
import { Activity, ChevronDown, RefreshCw, Loader2, Search } from "lucide-react";
import type { LivePlayerStat } from "@shared/schema";

const ESPN_TO_DB: Record<string, string> = {
  GS: "GSW", SA: "SAS", NO: "NOP", NY: "NYK",
  PHO: "PHX", UTH: "UTA", UTAH: "UTA", WSH: "WAS", CHO: "CHA",
};
const espnToDb = (abbr: string) => ESPN_TO_DB[abbr.toUpperCase()] ?? abbr.toUpperCase();

const TEAM_FULL_NAMES: Record<string, string> = {
  ATL: "Atlanta Hawks", BKN: "Brooklyn Nets", BOS: "Boston Celtics",
  CHA: "Charlotte Hornets", CHI: "Chicago Bulls", CLE: "Cleveland Cavaliers",
  DAL: "Dallas Mavericks", DEN: "Denver Nuggets", DET: "Detroit Pistons",
  GSW: "Golden State Warriors", HOU: "Houston Rockets", IND: "Indiana Pacers",
  LAC: "LA Clippers", LAL: "LA Lakers", MEM: "Memphis Grizzlies",
  MIA: "Miami Heat", MIL: "Milwaukee Bucks", MIN: "Minnesota Timberwolves",
  NOP: "New Orleans Pelicans", NYK: "New York Knicks", OKC: "OKC Thunder",
  ORL: "Orlando Magic", PHI: "Philadelphia 76ers", PHX: "Phoenix Suns",
  POR: "Portland Trail Blazers", SAC: "Sacramento Kings", SAS: "San Antonio Spurs",
  TOR: "Toronto Raptors", UTA: "Utah Jazz", WAS: "Washington Wizards",
};

const STAT_TYPES = [
  { value: "points", label: "Points" },
  { value: "rebounds", label: "Rebounds" },
  { value: "assists", label: "Assists" },
  { value: "threes", label: "3-Pointers Made" },
  { value: "steals", label: "Steals" },
  { value: "blocks", label: "Blocks" },
  { value: "pts_reb_ast", label: "Pts+Reb+Ast" },
  { value: "pts_reb", label: "Pts+Reb" },
  { value: "pts_ast", label: "Pts+Ast" },
  { value: "reb_ast", label: "Reb+Ast" },
  { value: "stl_blk", label: "Stl+Blk" },
];

const STAT_LABEL_MAP: Record<string, string> = {
  points: "PTS", rebounds: "REB", assists: "AST", steals: "STL",
  blocks: "BLK", threes: "3PM", pts_reb_ast: "PRA", pts_reb: "P+R",
  pts_ast: "P+A", reb_ast: "R+A", stl_blk: "S+B",
};

type SignalTier = "green" | "red" | "yellow" | "teal";
type PlayerSignal = { tier: SignalTier; displayProb: number; betDirection: string; statType: string };

const SIGNAL_STYLES: Record<SignalTier, { border: string; bg: string; dot: string }> = {
  green:  { border: "#22c55e", bg: "rgba(34,197,94,0.12)",   dot: "#22c55e" },
  red:    { border: "#ef4444", bg: "rgba(239,68,68,0.12)",   dot: "#ef4444" },
  yellow: { border: "#eab308", bg: "rgba(234,179,8,0.12)",   dot: "#eab308" },
  teal:   { border: "#00d4aa", bg: "rgba(0,212,170,0.12)",   dot: "#00d4aa" },
};

const SIGNAL_TIER_STYLES: Record<"elite" | "strong" | "value", { border: string; bg: string; dot: string }> = {
  elite:  { border: "#22c55e", bg: "rgba(34,197,94,0.12)",   dot: "#22c55e" },
  strong: { border: "#eab308", bg: "rgba(234,179,8,0.12)",   dot: "#eab308" },
  value:  { border: "#3b82f6", bg: "rgba(59,130,246,0.12)",  dot: "#3b82f6" },
};

function getSignalTier(prob: number): "elite" | "strong" | "value" | "none" {
  if (prob >= 85) return "elite";
  if (prob >= 70) return "strong";
  if (prob >= 60) return "value";
  return "none";
}

interface EngineEntry {
  probability: number;
  betDirection: "OVER" | "UNDER";
  edge: number;
  line: number | null;
  statType: string;
}

interface LiveBoxscoreProps {
  liveStats: LivePlayerStat[] | undefined;
  engineOutput: Record<number, Record<string, EngineEntry>> | undefined;
  halftimePlaysData: { plays: any[] } | undefined;
  liveSignalsData: { signals: any[]; engineOutput?: Record<number, Record<string, EngineEntry>> } | undefined;
  selectedPlayer: { id: number; name: string } | undefined;
  watchedStatType: string;
  isLiveStatsLoading: boolean;
  lastRefreshed: Date;
  onRefresh: () => void;
  onRowClick: (stat: LivePlayerStat) => void;
  currentGameId: string;
}

export function LiveBoxscore({
  liveStats,
  engineOutput,
  halftimePlaysData,
  liveSignalsData,
  selectedPlayer,
  watchedStatType,
  isLiveStatsLoading,
  lastRefreshed,
  onRefresh,
  onRowClick,
  currentGameId,
}: LiveBoxscoreProps) {
  const [showBoxScore, setShowBoxScore] = useState(true);
  const [boxScoreFilter, setBoxScoreFilter] = useState("");
  const [boxScoreSort, setBoxScoreSort] = useState<"stat" | "minutes">("stat");
  const [boxScoreSortDir, setBoxScoreSortDir] = useState<"desc" | "asc">("desc");

  const parseMinDec = (m: string) => {
    const parts = m.split(":");
    return parts.length === 2 ? parseInt(parts[0]) + parseInt(parts[1]) / 60 : parseFloat(m) || 0;
  };

  // Build ID-keyed signal maps from signals[] (edge >= 5 threshold preserved for row highlighting)
  const playerSignalMap = new Map<number, PlayerSignal>();
  const statCellSignalMap = new Map<number, PlayerSignal>();
  const signalSource = (liveSignalsData?.signals && liveSignalsData.signals.length > 0)
    ? liveSignalsData.signals
    : (halftimePlaysData?.plays ?? []);
  for (const play of signalSource) {
    const pid: number | undefined = play.playerId;
    if (!pid) continue;
    const dp = Math.round(play.probability * 10) / 10;
    const tier: SignalTier | null =
      dp >= 85 ? (play.betDirection === "under" ? "red" : "green") :
      dp >= 70 ? "yellow" :
      dp >= 55 ? "teal" : null;
    if (!tier) continue;
    // Row-level: best signal across all stat types
    const existing = playerSignalMap.get(pid);
    if (!existing || dp > existing.displayProb) {
      playerSignalMap.set(pid, { tier, displayProb: dp, betDirection: play.betDirection, statType: play.statType });
    }
    // Cell-level: only signals matching the active stat type column
    if (play.statType === watchedStatType) {
      const existingCell = statCellSignalMap.get(pid);
      if (!existingCell || dp > existingCell.displayProb) {
        statCellSignalMap.set(pid, { tier, displayProb: dp, betDirection: play.betDirection, statType: play.statType });
      }
    }
  }

  // Resolve engineOutput — prefer prop from liveSignalsData (freshly fetched), fall back to prop
  const resolvedEngineOutput: Record<number, Record<string, EngineEntry>> =
    (liveSignalsData?.engineOutput && Object.keys(liveSignalsData.engineOutput).length > 0)
      ? liveSignalsData.engineOutput
      : (engineOutput ?? {});

  const filterLower = boxScoreFilter.toLowerCase().trim();
  const playedStats = (liveStats ?? [])
    .filter(s => s.minutes !== "0" && s.minutes !== "0:00")
    .filter(s => !filterLower || s.playerName.toLowerCase().includes(filterLower));

  // TEMPORARY validation logging — remove after confirming enrichment coverage
  const totalLiveStatsCount = (liveStats ?? []).length;
  const badgeCount = (liveStats ?? []).filter(s => {
    const pid = s.playerId;
    if (!pid) return false;
    if (parseMinDec(s.minutes) < 3) return false;
    return !!resolvedEngineOutput[pid]?.[watchedStatType];
  }).length;
  const highlightedCount = (liveStats ?? []).filter(s => s.playerId != null && playerSignalMap.has(s.playerId as number)).length;
  console.log(`[boxscore] liveStats players: ${totalLiveStatsCount}`);
  console.log(`[boxscore] engineOutput playerIds: ${Object.keys(resolvedEngineOutput).length}`);
  console.log(`[boxscore] badges rendered for ${watchedStatType}: ${badgeCount}`);
  console.log(`[boxscore] highlighted players: ${highlightedCount}`);

  const getStatVal = (s: LivePlayerStat, statType: string): number => {
    if (statType === "points") return s.points;
    if (statType === "rebounds") return s.rebounds;
    if (statType === "assists") return s.assists;
    if (statType === "steals") return s.steals;
    if (statType === "blocks") return s.blocks;
    if (statType === "threes") return s.threes;
    if (statType === "pts_reb_ast") return s.points + s.rebounds + s.assists;
    if (statType === "pts_reb") return s.points + s.rebounds;
    if (statType === "pts_ast") return s.points + s.assists;
    if (statType === "reb_ast") return s.rebounds + s.assists;
    if (statType === "stl_blk") return s.steals + s.blocks;
    return s.points;
  };

  const teams = Array.from(new Set(playedStats.map(s => s.teamAbbr)));

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
        <button
          onClick={() => setShowBoxScore(!showBoxScore)}
          className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
          data-testid="button-toggle-boxscore"
        >
          <Activity className="w-3.5 h-3.5 text-green-500" />
          Live Box Score
          {liveStats && (
            <span className="text-muted-foreground/60 font-normal normal-case ml-1">
              — click a row to auto-fill
            </span>
          )}
          <ChevronDown className={`w-3.5 h-3.5 ml-1 transition-transform ${showBoxScore ? "rotate-180" : ""}`} />
        </button>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground/50">
            Auto-refreshes every 2 min · Last: {lastRefreshed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
          <button
            onClick={onRefresh}
            disabled={isLiveStatsLoading}
            data-testid="button-refresh-boxscore"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
          >
            <RefreshCw className={`w-3 h-3 ${isLiveStatsLoading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {showBoxScore && (
        isLiveStatsLoading ? (
          <div className="flex items-center justify-center py-6 text-xs text-muted-foreground gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Fetching live stats…
          </div>
        ) : liveStats && playedStats.length > 0 ? (
          <div>
            {/* Signal legend — only shown when halftime plays exist */}
            {(halftimePlaysData?.plays?.length ?? 0) > 0 && (
              <div className="px-4 pt-2 pb-1 flex items-center gap-3 text-[10px] text-muted-foreground/70 border-b border-border/20 flex-wrap">
                <span className="font-medium uppercase tracking-wider">Signal Key:</span>
                <span className="flex items-center gap-1"><span style={{ color: "#22c55e" }}>●</span> Over ≥85%</span>
                <span className="flex items-center gap-1"><span style={{ color: "#ef4444" }}>●</span> Under ≥85%</span>
                <span className="flex items-center gap-1"><span style={{ color: "#eab308" }}>●</span> 70–84%</span>
                <span className="flex items-center gap-1"><span style={{ color: "#00d4aa" }}>●</span> 60–69%</span>
              </div>
            )}

            {/* Filter + Sort Controls */}
            <div className="px-4 py-2 border-b border-border/40 flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/50" />
                <input
                  type="text"
                  placeholder="Filter by player name…"
                  value={boxScoreFilter}
                  onChange={e => setBoxScoreFilter(e.target.value)}
                  data-testid="input-boxscore-filter"
                  className="w-full h-8 pl-8 pr-3 rounded-lg bg-secondary/50 border border-border/50 text-xs focus:border-primary outline-none"
                />
              </div>
              <button
                data-testid="button-sort-stat"
                onClick={() => {
                  if (boxScoreSort === "stat") setBoxScoreSortDir(d => d === "desc" ? "asc" : "desc");
                  else setBoxScoreSort("stat");
                }}
                className={`flex items-center gap-1 px-2.5 h-8 rounded-lg border text-xs font-medium transition-colors ${
                  boxScoreSort === "stat" ? "border-primary bg-primary/10 text-primary" : "border-border/50 bg-secondary/30 text-muted-foreground hover:text-foreground"
                }`}
              >
                Stat {boxScoreSort === "stat" ? (boxScoreSortDir === "desc" ? "▼" : "▲") : ""}
              </button>
              <button
                data-testid="button-sort-minutes"
                onClick={() => {
                  if (boxScoreSort === "minutes") setBoxScoreSortDir(d => d === "desc" ? "asc" : "desc");
                  else setBoxScoreSort("minutes");
                }}
                className={`flex items-center gap-1 px-2.5 h-8 rounded-lg border text-xs font-medium transition-colors ${
                  boxScoreSort === "minutes" ? "border-primary bg-primary/10 text-primary" : "border-border/50 bg-secondary/30 text-muted-foreground hover:text-foreground"
                }`}
              >
                MIN {boxScoreSort === "minutes" ? (boxScoreSortDir === "desc" ? "▼" : "▲") : ""}
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground/70 border-b border-border/40">
                    <th className="text-left px-4 py-2 font-medium">Player</th>
                    <th className="text-right px-3 py-2 font-medium">MIN</th>
                    <th className="text-right px-3 py-2 font-medium text-primary">
                      {STAT_TYPES.find(s => s.value === watchedStatType)?.label ?? "PTS"}
                    </th>
                    <th className="text-right px-3 py-2 font-medium">PTS</th>
                    <th className="text-right px-3 py-2 font-medium">REB</th>
                    <th className="text-right px-3 py-2 font-medium">AST</th>
                    <th className="text-right px-3 py-2 font-medium">FGM-FGA</th>
                    <th className="text-right px-3 py-2 font-medium">FTM-FTA</th>
                    <th className="text-right px-3 py-2 font-medium">3PM-3PA</th>
                  </tr>
                </thead>
                <tbody>
                  {teams.flatMap((team, ti) => [
                    <tr key={`team-${team}`} className={ti > 0 ? "border-t-2 border-border/60" : ""}>
                      <td colSpan={9} className="px-4 py-1 text-muted-foreground/60 font-semibold uppercase tracking-wider text-[10px] bg-secondary/20">
                        {espnToDb(team)} — {TEAM_FULL_NAMES[espnToDb(team)] ?? team}
                      </td>
                    </tr>,
                    ...Array.from(
                      new Map(
                        playedStats
                          .filter(s => s.teamAbbr === team && s.gameId === currentGameId)
                          .map(s => [`${s.gameId}:${s.teamAbbr}:${s.playerId ?? s.playerName}`, s])
                      ).values()
                    )
                      .sort((a, b) => {
                        const pid_a = a.playerId as number | null;
                        const pid_b = b.playerId as number | null;
                        const sigA = pid_a != null ? playerSignalMap.get(pid_a) : undefined;
                        const sigB = pid_b != null ? playerSignalMap.get(pid_b) : undefined;
                        if (sigA && !sigB) return -1;
                        if (!sigA && sigB) return 1;
                        if (sigA && sigB) return sigB.displayProb - sigA.displayProb;
                        const sortVal = boxScoreSort === "minutes"
                          ? parseMinDec(a.minutes) - parseMinDec(b.minutes)
                          : getStatVal(a, watchedStatType) - getStatVal(b, watchedStatType);
                        return boxScoreSortDir === "desc" ? -sortVal : sortVal;
                      })
                      .map((stat) => {
                        const pid = stat.playerId as number | null;
                        const isSelected = selectedPlayer != null && pid === selectedPlayer.id;

                        // Row highlight: ID-keyed from signals[] (edge >= 5 filtered — strong signals only)
                        const signal = pid != null ? playerSignalMap.get(pid) ?? null : null;

                        // Badge: ID-keyed from engineOutput (no edge filter — shows all valid entries, minutes >= 3 required)
                        const minutesDecimal = parseMinDec(stat.minutes);
                        const engineEntry = (pid != null && minutesDecimal >= 3)
                          ? resolvedEngineOutput[pid]?.[watchedStatType] ?? null
                          : null;

                        const statTotal = getStatVal(stat, watchedStatType);
                        const fgPct = stat.fga != null && stat.fga > 0 ? `${stat.fgm ?? 0}-${stat.fga}` : "—";
                        const ftPct = stat.fta != null && stat.fta > 0 ? `${stat.ftm ?? 0}-${stat.fta}` : "—";
                        const fg3Pct = stat.fg3a != null && stat.fg3a > 0 ? `${stat.fg3m ?? 0}-${stat.fg3a}` : "—";

                        const signalStyle = !isSelected && signal ? SIGNAL_STYLES[signal.tier] : null;
                        const rowStyle = signalStyle
                          ? { background: signalStyle.bg, boxShadow: `inset 4px 0 0 ${signalStyle.border}` }
                          : undefined;

                        // Badge display derived from engineEntry (probability badge — decoupled from highlight)
                        let badgeElement: JSX.Element | null = null;
                        if (!isSelected && engineEntry) {
                          const dp = Math.round(engineEntry.probability * 10) / 10;
                          const sigTierKey = getSignalTier(dp);
                          const tierStyle = sigTierKey !== "none"
                            ? SIGNAL_TIER_STYLES[sigTierKey]
                            : SIGNAL_STYLES["teal"];
                          const directionLabel = engineEntry.betDirection === "UNDER" ? "UNDER" : "OVER";
                          badgeElement = (
                            <span
                              title={`${directionLabel} ${STAT_LABEL_MAP[watchedStatType] ?? watchedStatType} — ${dp}% model confidence`}
                              data-testid={`signal-dot-${pid}`}
                              style={{
                                background: tierStyle.bg,
                                color: tierStyle.dot,
                                border: `1px solid ${tierStyle.border}`,
                                fontSize: "13px",
                                fontWeight: 600,
                                padding: "4px 8px",
                                borderRadius: "6px",
                              }}
                              className="cursor-help select-none ml-0.5 whitespace-nowrap leading-none"
                            >
                              {directionLabel} {STAT_LABEL_MAP[watchedStatType] ?? watchedStatType} {dp}%
                            </span>
                          );
                        }

                        // Stat cell color: use stat-type-specific signal for exact column color
                        const statCellSignal = pid != null ? statCellSignalMap.get(pid) ?? null : null;
                        const statCellColor = statCellSignal ? SIGNAL_STYLES[statCellSignal.tier].dot : "#00d4aa";

                        return (
                          <tr
                            key={`player-${pid ?? stat.playerName}`}
                            onClick={() => onRowClick(stat)}
                            data-testid={`boxscore-row-${pid}`}
                            style={rowStyle}
                            className={`border-b border-border/20 cursor-pointer transition-all ${
                              isSelected
                                ? "bg-primary/10 border-l-2 border-l-primary"
                                : signal ? "" : "hover:bg-secondary/40"
                            }`}
                          >
                            <td className="px-4 py-2 font-medium text-foreground">
                              <span className="flex items-center gap-1.5">
                                <span>{stat.playerName}</span>
                                {isSelected && <span className="text-primary text-[10px] font-bold">●</span>}
                                {badgeElement}
                              </span>
                            </td>
                            <td className="text-right px-3 py-2 font-mono text-muted-foreground">{stat.minutes}</td>
                            <td className="text-right px-3 py-2 font-mono font-bold" style={{ color: statCellColor }}>{statTotal}</td>
                            <td className="text-right px-3 py-2 font-mono">{stat.points}</td>
                            <td className="text-right px-3 py-2 font-mono">{stat.rebounds}</td>
                            <td className="text-right px-3 py-2 font-mono">{stat.assists}</td>
                            <td className="text-right px-3 py-2 font-mono text-muted-foreground">{fgPct}</td>
                            <td className="text-right px-3 py-2 font-mono text-muted-foreground">{ftPct}</td>
                            <td className="text-right px-3 py-2 font-mono text-muted-foreground">{fg3Pct}</td>
                          </tr>
                        );
                      }),
                  ])}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="py-6 text-center text-xs text-muted-foreground">
            No live stats available yet — box score updates once the game starts.
          </div>
        )
      )}
    </div>
  );
}
