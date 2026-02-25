import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { calculateProbabilitySchema, type CalculateProbabilityRequest, type ParlayPickInput } from "@shared/schema";
import { usePlayers, useTeams, useCalculateProbability, useLiveGames, useLiveStats, usePlayerOdds } from "@/hooks/use-nba";
import { ProbabilityRing } from "@/components/probability-ring";
import { StatCard } from "@/components/stat-card";
import { ParlaySlip } from "@/components/parlay-slip";
import {
  Activity,
  Clock,
  AlertTriangle,
  Target,
  ShieldAlert,
  TrendingUp,
  ChevronDown,
  Zap,
  Radio,
  RefreshCw,
  Plus,
  Trophy,
  Loader2,
} from "lucide-react";

const STAT_TYPES = [
  { value: "points", label: "Points" },
  { value: "rebounds", label: "Rebounds" },
  { value: "assists", label: "Assists" },
  { value: "steals", label: "Steals" },
  { value: "blocks", label: "Blocks" },
  { value: "pts_reb_ast", label: "Pts+Reb+Ast" },
  { value: "pts_reb", label: "Pts+Reb" },
  { value: "pts_ast", label: "Pts+Ast" },
  { value: "reb_ast", label: "Reb+Ast" },
  { value: "stl_blk", label: "Stl+Blk" },
];

const SPORTSBOOK_LABELS: Record<string, string> = {
  draftkings: "DraftKings",
  fanduel: "FanDuel",
  hardrockbet: "Hard Rock",
};

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

function formatOdds(odds: number): string {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

export default function Dashboard() {
  const { data: players, isLoading: isPlayersLoading } = usePlayers();
  const { data: teams, isLoading: isTeamsLoading } = useTeams();
  const { data: liveGames, isLoading: isGamesLoading, refetch: refetchGames } = useLiveGames();

  const [selectedGameId, setSelectedGameId] = useState<string | undefined>();
  const [parlayPicks, setParlayPicks] = useState<ParlayPickInput[]>([]);
  const [showParlay, setShowParlay] = useState(false);
  const [selectedSportsbook, setSelectedSportsbook] = useState<string>("manual");

  const calculateMutation = useCalculateProbability();

  const form = useForm<CalculateProbabilityRequest>({
    resolver: zodResolver(calculateProbabilitySchema),
    defaultValues: {
      halftimeMinutes: 0,
      halftimeFouls: 0,
      halftimeStat: 0,
      liveLine: 0,
      statType: "points",
      halftimeScore: "",
      gameId: "",
    },
  });

  const watchedPlayerId = form.watch("playerId");
  const watchedStatType = form.watch("statType");

  // Get selected player info
  const selectedPlayer = players?.find((p) => p.id === Number(watchedPlayerId));

  // Live stats for selected game
  const { data: liveStats } = useLiveStats(selectedGameId);

  // Live odds for selected player
  const { data: oddsData, isLoading: isOddsLoading } = usePlayerOdds(
    selectedGameId,
    selectedPlayer?.name,
    watchedStatType
  );

  // Auto-fill halftime stats from live box score when player changes
  useEffect(() => {
    if (!liveStats || !selectedPlayer) return;
    const playerStat = liveStats.find(
      (s) =>
        s.playerName.toLowerCase().includes(selectedPlayer.name.toLowerCase().split(" ")[1] ?? "") ||
        selectedPlayer.name.toLowerCase().includes(s.playerName.toLowerCase().split(" ")[1] ?? "")
    );
    if (!playerStat) return;

    // Parse minutes "MM:SS" → decimal
    const minParts = playerStat.minutes.split(":");
    const minutesDecimal = minParts.length === 2
      ? parseInt(minParts[0]) + parseInt(minParts[1]) / 60
      : parseFloat(playerStat.minutes) || 0;

    form.setValue("halftimeMinutes", Math.round(minutesDecimal * 10) / 10);
    form.setValue("halftimeFouls", playerStat.fouls);

    const st = watchedStatType;
    let statVal = 0;
    if (st === "points") statVal = playerStat.points;
    else if (st === "rebounds") statVal = playerStat.rebounds;
    else if (st === "assists") statVal = playerStat.assists;
    else if (st === "steals") statVal = playerStat.steals;
    else if (st === "blocks") statVal = playerStat.blocks;
    else if (st === "pts_reb_ast") statVal = playerStat.points + playerStat.rebounds + playerStat.assists;
    else if (st === "pts_reb") statVal = playerStat.points + playerStat.rebounds;
    else if (st === "pts_ast") statVal = playerStat.points + playerStat.assists;
    else if (st === "reb_ast") statVal = playerStat.rebounds + playerStat.assists;
    else if (st === "stl_blk") statVal = playerStat.steals + playerStat.blocks;
    form.setValue("halftimeStat", statVal);
  }, [liveStats, selectedPlayer, watchedStatType]);

  const onSubmit = (data: CalculateProbabilityRequest) => {
    calculateMutation.mutate({ ...data, gameId: selectedGameId });
  };

  const handleAddToParlay = () => {
    if (!calculateMutation.data || !selectedPlayer) return;
    const result = calculateMutation.data;
    const formVals = form.getValues();
    const odds = oddsData && selectedSportsbook !== "manual"
      ? oddsData[selectedSportsbook]
      : null;

    const pick: ParlayPickInput = {
      playerId: selectedPlayer.id,
      playerName: selectedPlayer.name,
      playerTeam: selectedPlayer.team,
      statType: formVals.statType,
      line: formVals.liveLine,
      probability: result.probability,
      sportsbook: selectedSportsbook !== "manual" ? selectedSportsbook : "",
      oddsAmerican: odds?.overOdds ?? 0,
      gameId: selectedGameId,
    };

    if (parlayPicks.length < 10) {
      setParlayPicks((prev) => [...prev, pick]);
      setShowParlay(true);
    }
  };

  const playersByTeam = (players ?? []).reduce<Record<string, typeof players>>((acc, p) => {
    if (!acc[p.team]) acc[p.team] = [];
    acc[p.team]!.push(p);
    return acc;
  }, {});
  const sortedTeamKeys = Object.keys(playersByTeam).sort();

  const isLoading = isPlayersLoading || isTeamsLoading;
  const result = calculateMutation.data;

  const activeGames = (liveGames ?? []).filter(
    (g) => g.status !== "Scheduled" && g.status !== "Final"
  );
  const allGames = liveGames ?? [];

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin w-12 h-12 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-20 bg-background">
      {/* Header */}
      <header className="border-b border-border/40 bg-background/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
              <Activity className="w-5 h-5 text-primary-foreground" />
            </div>
            <h1 className="text-xl font-bold tracking-tight">
              NBA Live <span className="text-primary">Prop Predictor</span>
            </h1>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Radio className="w-3 h-3 text-green-500 animate-pulse" />
              <span>
                {isGamesLoading
                  ? "Fetching..."
                  : `${activeGames.length} live game${activeGames.length !== 1 ? "s" : ""}`}
              </span>
            </div>
            <button
              onClick={() => setShowParlay(!showParlay)}
              data-testid="button-toggle-parlay"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 border border-primary/30 text-primary text-sm font-semibold hover:bg-primary/20 transition-colors"
            >
              <Trophy className="w-4 h-4" />
              Parlay Slip
              {parlayPicks.length > 0 && (
                <span className="bg-primary text-primary-foreground text-xs rounded-full w-5 h-5 flex items-center justify-center">
                  {parlayPicks.length}
                </span>
              )}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 mt-6 space-y-5">

        {/* Live Games Strip */}
        {allGames.length > 0 && (
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                <Radio className="w-3.5 h-3.5 text-green-500" /> Today's Games
              </h2>
              <button
                onClick={() => refetchGames()}
                className="text-muted-foreground flex items-center gap-1 text-xs hover:text-foreground"
                data-testid="button-refresh-games"
              >
                <RefreshCw className="w-3 h-3" /> Refresh
              </button>
            </div>
            <div className="flex gap-2 flex-wrap">
              {allGames.map((game) => {
                const isLive = game.status !== "Scheduled" && game.status !== "Final";
                const isSelected = game.id === selectedGameId;
                const scoreStr = `${game.awayScore}-${game.homeScore}`;

                return (
                  <button
                    key={game.id}
                    data-testid={`button-game-${game.id}`}
                    onClick={() => {
                      if (isSelected) {
                        setSelectedGameId(undefined);
                        form.setValue("halftimeScore", "");
                        form.setValue("gameId", "");
                      } else {
                        setSelectedGameId(game.id);
                        form.setValue("gameId", game.id);
                        if (game.period >= 2) {
                          form.setValue("halftimeScore", scoreStr);
                        }
                        const homeAbbr = game.homeTeamAbbr.toUpperCase();
                        const awayAbbr = game.awayTeamAbbr.toUpperCase();
                        if (teams?.includes(homeAbbr)) form.setValue("opponentTeam", homeAbbr);
                        else if (teams?.includes(awayAbbr)) form.setValue("opponentTeam", awayAbbr);
                      }
                    }}
                    className={`flex flex-col items-center px-3 py-2 rounded-lg border text-xs min-w-[130px] transition-all ${
                      isSelected
                        ? "border-primary bg-primary/10 ring-1 ring-primary"
                        : "border-border/60 bg-secondary/40 hover:bg-secondary/70"
                    }`}
                  >
                    <div className="flex items-center justify-between w-full gap-2">
                      <span className="font-semibold text-foreground">{game.awayTeamAbbr}</span>
                      <span className="font-mono text-primary font-bold">
                        {game.awayScore} – {game.homeScore}
                      </span>
                      <span className="font-semibold text-foreground">{game.homeTeamAbbr}</span>
                    </div>
                    <div className="flex items-center gap-1 text-muted-foreground mt-0.5">
                      {isLive && <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse inline-block" />}
                      <span>{isLive ? `Q${game.period} ${game.clock}` : game.status}</span>
                      {isSelected && <span className="text-primary font-medium ml-1">● Selected</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Main 3-column layout */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">

          {/* LEFT: Input Form */}
          <div className="lg:col-span-4 space-y-4">
            <div className="bg-card border border-border rounded-xl p-5 relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-0.5 bg-gradient-to-r from-primary to-transparent" />
              <h2 className="text-lg font-semibold mb-1">Matchup Details</h2>
              <p className="text-muted-foreground text-xs mb-4">Enter halftime stats to calculate 2H probability.</p>

              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                {/* Player */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Player</label>
                  <div className="relative">
                    <select
                      {...form.register("playerId")}
                      data-testid="select-player"
                      className="w-full h-10 px-3 rounded-lg bg-input border border-border focus:border-primary outline-none appearance-none text-sm"
                    >
                      <option value="">Select Player...</option>
                      {sortedTeamKeys.map((team) => (
                        <optgroup key={team} label={`${team} – ${TEAM_FULL_NAMES[team] ?? team}`}>
                          {playersByTeam[team]!.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} ({p.position})
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                  </div>
                </div>

                {/* Opponent */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Opponent Team</label>
                  <div className="relative">
                    <select
                      {...form.register("opponentTeam")}
                      data-testid="select-opponent"
                      className="w-full h-10 px-3 rounded-lg bg-input border border-border focus:border-primary outline-none appearance-none text-sm"
                    >
                      <option value="">Select Opponent...</option>
                      {teams?.map((t) => (
                        <option key={t} value={t}>
                          {t} – {TEAM_FULL_NAMES[t] ?? t}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                  </div>
                </div>

                {/* Halftime Situation */}
                <div className="p-3.5 rounded-lg bg-secondary/40 border border-border/50 space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <Clock className="w-3 h-3" />
                    Halftime Situation
                    {liveStats && selectedGameId && (
                      <span className="text-green-400 text-xs normal-case font-normal ml-1 flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse inline-block" />
                        Live auto-fill
                      </span>
                    )}
                  </h3>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Minutes</label>
                      <input
                        type="number" step="0.1"
                        {...form.register("halftimeMinutes")}
                        data-testid="input-minutes"
                        className="w-full h-9 px-3 rounded-lg bg-input border border-border focus:border-primary outline-none text-sm font-mono"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Fouls</label>
                      <input
                        type="number"
                        {...form.register("halftimeFouls")}
                        data-testid="input-fouls"
                        className="w-full h-9 px-3 rounded-lg bg-input border border-border focus:border-primary outline-none text-sm font-mono"
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground flex items-center gap-1">
                      <Zap className="w-3 h-3 text-yellow-500" />
                      Halftime Score (optional)
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. 62-55"
                      {...form.register("halftimeScore")}
                      data-testid="input-score"
                      className="w-full h-9 px-3 rounded-lg bg-input border border-border focus:border-primary outline-none text-sm font-mono"
                    />
                  </div>
                </div>

                {/* Stat Type + Line */}
                <div className="p-3.5 rounded-lg bg-secondary/40 border border-border/50 space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <Target className="w-3 h-3" /> The Line
                  </h3>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Stat / Prop Type</label>
                    <div className="relative">
                      <select
                        {...form.register("statType")}
                        data-testid="select-stat-type"
                        className="w-full h-9 pl-3 pr-8 rounded-lg bg-input border border-border focus:border-primary outline-none appearance-none text-sm"
                      >
                        {STAT_TYPES.map((s) => (
                          <option key={s.value} value={s.value}>{s.label}</option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Current Stat</label>
                      <input
                        type="number" step="0.5"
                        {...form.register("halftimeStat")}
                        data-testid="input-current-stat"
                        className="w-full h-9 px-3 rounded-lg bg-input border border-border focus:border-primary outline-none text-sm font-mono"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-primary font-medium">Live Line</label>
                      <input
                        type="number" step="0.5"
                        {...form.register("liveLine")}
                        data-testid="input-live-line"
                        className="w-full h-9 px-3 rounded-lg bg-primary/10 border border-primary/40 focus:border-primary outline-none text-sm font-mono text-primary font-bold"
                      />
                    </div>
                  </div>

                  {/* Live Odds from Sportsbooks */}
                  {selectedGameId && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-xs text-muted-foreground">Live Lines by Book</label>
                        {isOddsLoading && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
                      </div>
                      {!process.env.ODDS_API_KEY && !oddsData && (
                        <p className="text-xs text-muted-foreground/60 bg-secondary/50 rounded-lg p-2 border border-border/40">
                          Set <code className="text-primary">ODDS_API_KEY</code> to see live sportsbook lines.
                          <a href="https://the-odds-api.com" target="_blank" rel="noopener noreferrer" className="text-primary ml-1 underline">Get free key</a>
                        </p>
                      )}
                      {oddsData && Object.keys(oddsData).length > 0 && (
                        <div className="space-y-1.5">
                          {Object.entries(oddsData).map(([sb, odds]) => (
                            <button
                              key={sb}
                              type="button"
                              data-testid={`button-odds-${sb}`}
                              onClick={() => {
                                form.setValue("liveLine", odds.line);
                                setSelectedSportsbook(sb);
                              }}
                              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg border text-xs transition-all ${
                                selectedSportsbook === sb
                                  ? "border-primary bg-primary/10 text-primary"
                                  : "border-border/50 bg-secondary/30 hover:bg-secondary/60 text-foreground"
                              }`}
                            >
                              <span className="font-semibold">{SPORTSBOOK_LABELS[sb] ?? sb}</span>
                              <span className="font-mono font-bold">{odds.line}</span>
                              <span className="text-muted-foreground">
                                O {formatOdds(odds.overOdds)} / U {formatOdds(odds.underOdds)}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                      {oddsData && Object.keys(oddsData).length === 0 && !isOddsLoading && (
                        <p className="text-xs text-muted-foreground/60">No live lines found for this player/stat.</p>
                      )}
                    </div>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={calculateMutation.isPending}
                  data-testid="button-calculate"
                  className="w-full h-10 rounded-lg bg-primary text-primary-foreground font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {calculateMutation.isPending ? (
                    <div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" />
                  ) : (
                    "Calculate Probability"
                  )}
                </button>
              </form>
            </div>
          </div>

          {/* CENTER: Results */}
          <div className={showParlay ? "lg:col-span-5" : "lg:col-span-8"}>
            {!result ? (
              <div className="h-full min-h-[400px] flex flex-col items-center justify-center border-2 border-dashed border-border/50 rounded-xl text-muted-foreground bg-card/20 p-8 text-center">
                <div className="w-16 h-16 rounded-full bg-secondary flex items-center justify-center mb-4">
                  <Activity className="w-8 h-8 text-muted-foreground/50" />
                </div>
                <h3 className="text-lg font-medium text-foreground mb-1">Awaiting Input</h3>
                <p className="max-w-sm text-sm">Select a player and opponent, enter halftime stats, then calculate.</p>
                {allGames.length > 0 && (
                  <p className="text-xs text-muted-foreground/60 mt-2">Tip: Click a live game above to auto-fill stats.</p>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                {/* Main Result Card */}
                <div className="bg-card border border-border rounded-xl p-5 relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-48 h-48 bg-primary/5 rounded-full blur-[60px] -translate-y-1/2 translate-x-1/2 pointer-events-none" />
                  <div className="flex flex-col md:flex-row items-center justify-between gap-5">
                    <div className="flex-1 space-y-3 z-10">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1">Live Prediction</p>
                        <div className="text-2xl font-bold tracking-tight">
                          {selectedPlayer?.name ?? "Player"} —{" "}
                          {STAT_TYPES.find((s) => s.value === form.getValues("statType"))?.label}{" "}
                          <span className="text-primary">{form.getValues("liveLine")}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 text-sm">
                        <TrendingUp className="w-4 h-4 text-muted-foreground" />
                        <span className="text-muted-foreground">
                          At half: <span className="text-foreground font-bold">{form.getValues("halftimeStat")}</span>
                          {" · "}Needs{" "}
                          <span className="text-foreground font-bold">
                            {Math.max(0, form.getValues("liveLine") - form.getValues("halftimeStat")).toFixed(1)}
                          </span>{" "}
                          more
                        </span>
                      </div>
                      {selectedPlayer?.ppg && (
                        <div className="flex gap-3 text-xs text-muted-foreground">
                          <span>Season: <strong className="text-foreground">{Number(selectedPlayer.ppg).toFixed(1)}</strong> PPG</span>
                          {selectedPlayer.rpg && <span><strong className="text-foreground">{Number(selectedPlayer.rpg).toFixed(1)}</strong> RPG</span>}
                          {selectedPlayer.apg && <span><strong className="text-foreground">{Number(selectedPlayer.apg).toFixed(1)}</strong> APG</span>}
                          {selectedPlayer.avgMinutes && <span><strong className="text-foreground">{Number(selectedPlayer.avgMinutes).toFixed(1)}</strong> MPG</span>}
                        </div>
                      )}

                      {/* Add to Parlay button */}
                      <button
                        type="button"
                        onClick={handleAddToParlay}
                        disabled={parlayPicks.length >= 10}
                        data-testid="button-add-to-parlay"
                        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary/10 border border-primary/30 text-primary text-sm font-semibold hover:bg-primary/20 transition-colors disabled:opacity-40"
                      >
                        <Plus className="w-4 h-4" /> Add to Parlay
                        {parlayPicks.length >= 10 && <span className="text-xs">(max 10)</span>}
                      </button>
                    </div>
                    <div className="flex-shrink-0 z-10">
                      <ProbabilityRing probability={result.probability} />
                    </div>
                  </div>
                </div>

                {/* Stats Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <StatCard
                    title="Expected Total"
                    value={result.expectedTotal.toFixed(1)}
                    subtitle={`Need: ${form.getValues("liveLine")}`}
                    icon={<Target className="w-4 h-4" />}
                    highlight={result.expectedTotal >= form.getValues("liveLine") ? "positive" : "negative"}
                  />
                  <StatCard
                    title="Proj. 2H Min"
                    value={result.projectedSecondHalfMinutes.toFixed(1)}
                    subtitle={`1H: ${form.getValues("halftimeMinutes")} min`}
                    icon={<Clock className="w-4 h-4" />}
                    highlight="neutral"
                  />
                  <StatCard
                    title="Defense vs Pos"
                    value={`${result.defenseMultiplier > 1 ? "+" : ""}${((result.defenseMultiplier - 1) * 100).toFixed(1)}%`}
                    subtitle="Opp allow vs position"
                    icon={<ShieldAlert className="w-4 h-4" />}
                    highlight={result.defenseMultiplier > 1 ? "positive" : "negative"}
                  />
                  <StatCard
                    title="Game Pace"
                    value={result.paceLabel}
                    subtitle={`${result.teamPace} vs ${result.opponentPace} pos/48`}
                    icon={<Zap className="w-4 h-4" />}
                    highlight={result.paceMultiplier >= 1.02 ? "positive" : result.paceMultiplier <= 0.97 ? "negative" : "neutral"}
                  />
                </div>

                {/* Foul Alert */}
                {form.getValues("halftimeFouls") >= 3 && (
                  <div className="bg-destructive/10 border border-destructive/30 rounded-xl p-4 flex gap-3 items-start">
                    <AlertTriangle className="w-5 h-5 text-destructive mt-0.5 flex-shrink-0" />
                    <div>
                      <h4 className="text-sm font-semibold text-destructive">Foul Trouble Alert</h4>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        {form.getValues("halftimeFouls")} fouls at half — projected 2H minutes are heavily discounted (
                        {form.getValues("halftimeFouls") >= 4 ? "55%" : "30%"} reduction). Bench time likely.
                      </p>
                    </div>
                  </div>
                )}

                {/* Pace Note */}
                {form.getValues("halftimeScore") && (
                  <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 flex gap-3 items-start">
                    <Zap className="w-5 h-5 text-yellow-500 mt-0.5 flex-shrink-0" />
                    <div>
                      <h4 className="text-sm font-semibold text-yellow-600 dark:text-yellow-400">Live Pace Active</h4>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        Score {form.getValues("halftimeScore")} blended with team history → {result.paceLabel.toLowerCase()}{" "}
                        game ({((result.paceMultiplier - 1) * 100).toFixed(1)}% vs league avg).
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* RIGHT: Parlay Slip */}
          {showParlay && (
            <div className="lg:col-span-3">
              <div className="bg-card border border-border rounded-xl p-4 sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto">
                <div className="absolute top-0 left-0 w-full h-0.5 bg-gradient-to-r from-primary to-transparent rounded-t-xl" />
                <ParlaySlip
                  picks={parlayPicks}
                  onRemove={(idx) => setParlayPicks((prev) => prev.filter((_, i) => i !== idx))}
                  onClear={() => { setParlayPicks([]); setShowParlay(false); }}
                />
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
