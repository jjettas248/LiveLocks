import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { calculateProbabilitySchema, type CalculateProbabilityRequest } from "@shared/schema";
import { usePlayers, useTeams, useCalculateProbability, useLiveGames } from "@/hooks/use-nba";
import { ProbabilityRing } from "@/components/probability-ring";
import { StatCard } from "@/components/stat-card";
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

export default function Dashboard() {
  const { data: players, isLoading: isPlayersLoading } = usePlayers();
  const { data: teams, isLoading: isTeamsLoading } = useTeams();
  const { data: liveGames, isLoading: isGamesLoading, refetch: refetchGames } = useLiveGames();
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
    },
  });

  const onSubmit = (data: CalculateProbabilityRequest) => {
    calculateMutation.mutate(data);
  };

  // Group players by team for the dropdown
  const playersByTeam = (players ?? []).reduce<Record<string, typeof players>>((acc, p) => {
    if (!acc[p.team]) acc[p.team] = [];
    acc[p.team]!.push(p);
    return acc;
  }, {});
  const sortedTeams = Object.keys(playersByTeam).sort();

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
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
              <Activity className="w-5 h-5 text-primary-foreground" />
            </div>
            <h1 className="text-xl font-bold tracking-tight">
              NBA Live Line <span className="text-primary">Predictor</span>
            </h1>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Radio className="w-3 h-3 text-green-500 animate-pulse" />
            <span>
              {isGamesLoading ? "Fetching live data..." : `${activeGames.length} live game${activeGames.length !== 1 ? "s" : ""}`}
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-6 space-y-6">

        {/* Live Games Strip */}
        {allGames.length > 0 && (
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                <Radio className="w-4 h-4 text-green-500" /> Today's Games
              </h2>
              <button
                onClick={() => refetchGames()}
                className="text-muted-foreground flex items-center gap-1 text-xs"
                data-testid="button-refresh-games"
              >
                <RefreshCw className="w-3 h-3" /> Refresh
              </button>
            </div>
            <div className="flex gap-3 flex-wrap">
              {allGames.map((game) => {
                const isLive = game.status !== "Scheduled" && game.status !== "Final";
                const isFinal = game.status === "Final";
                const scoreStr = `${game.awayScore}-${game.homeScore}`;
                return (
                  <button
                    key={game.id}
                    data-testid={`button-game-${game.id}`}
                    onClick={() => {
                      if (!isFinal && game.period >= 2) {
                        form.setValue("halftimeScore", scoreStr);
                        const homeAbbr = game.homeTeamAbbr.toUpperCase();
                        const awayAbbr = game.awayTeamAbbr.toUpperCase();
                        if (teams?.includes(homeAbbr)) form.setValue("opponentTeam", homeAbbr);
                        else if (teams?.includes(awayAbbr)) form.setValue("opponentTeam", awayAbbr);
                      }
                    }}
                    className="flex flex-col items-center px-4 py-2 rounded-lg border border-border/60 bg-secondary/40 text-xs min-w-[130px] text-left gap-1"
                  >
                    <div className="flex items-center justify-between w-full">
                      <span className="font-semibold text-foreground">{game.awayTeamAbbr}</span>
                      <span className="font-mono text-primary font-bold">
                        {game.awayScore} – {game.homeScore}
                      </span>
                      <span className="font-semibold text-foreground">{game.homeTeamAbbr}</span>
                    </div>
                    <div className="flex items-center gap-1 text-muted-foreground">
                      {isLive && <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse inline-block" />}
                      <span>{isLive ? `Q${game.period} ${game.clock}` : game.status}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* LEFT COLUMN: Input Form */}
          <div className="lg:col-span-5 space-y-4">
            <div className="bg-card border border-border rounded-xl p-6 relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-0.5 bg-gradient-to-r from-primary to-transparent" />

              <div className="mb-5">
                <h2 className="text-xl font-semibold">Matchup Details</h2>
                <p className="text-muted-foreground text-sm mt-1">Enter halftime stats to calculate 2H probability.</p>
              </div>

              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                {/* Player */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Player</label>
                  <div className="relative">
                    <select
                      {...form.register("playerId")}
                      data-testid="select-player"
                      className="w-full h-11 px-4 rounded-lg bg-input border border-border focus:border-primary outline-none appearance-none text-sm"
                    >
                      <option value="">Select Player...</option>
                      {sortedTeams.map((team) => (
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
                  {form.formState.errors.playerId && (
                    <p className="text-xs text-destructive">{form.formState.errors.playerId.message}</p>
                  )}
                </div>

                {/* Opponent */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Opponent Team</label>
                  <div className="relative">
                    <select
                      {...form.register("opponentTeam")}
                      data-testid="select-opponent"
                      className="w-full h-11 px-4 rounded-lg bg-input border border-border focus:border-primary outline-none appearance-none text-sm"
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
                  {form.formState.errors.opponentTeam && (
                    <p className="text-xs text-destructive">{form.formState.errors.opponentTeam.message}</p>
                  )}
                </div>

                {/* Halftime Stats */}
                <div className="p-4 rounded-lg bg-secondary/40 border border-border/50 space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                    <Clock className="w-3.5 h-3.5" /> Halftime Situation
                  </h3>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">Minutes Played</label>
                      <input
                        type="number" step="0.1"
                        {...form.register("halftimeMinutes")}
                        data-testid="input-minutes"
                        className="w-full h-10 px-3 rounded-lg bg-input border border-border focus:border-primary outline-none text-base font-mono"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">Fouls</label>
                      <input
                        type="number"
                        {...form.register("halftimeFouls")}
                        data-testid="input-fouls"
                        className="w-full h-10 px-3 rounded-lg bg-input border border-border focus:border-primary outline-none text-base font-mono"
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                      <Zap className="w-3 h-3 text-yellow-500" /> Halftime Score (optional — auto-fills from live games above)
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. 62-55"
                      {...form.register("halftimeScore")}
                      data-testid="input-score"
                      className="w-full h-10 px-3 rounded-lg bg-input border border-border focus:border-primary outline-none text-base font-mono"
                    />
                  </div>
                </div>

                {/* The Line */}
                <div className="p-4 rounded-lg bg-secondary/40 border border-border/50 space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                    <Target className="w-3.5 h-3.5" /> The Line
                  </h3>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Stat / Prop Type</label>
                    <div className="relative">
                      <select
                        {...form.register("statType")}
                        data-testid="select-stat-type"
                        className="w-full h-10 pl-3 pr-8 rounded-lg bg-input border border-border focus:border-primary outline-none appearance-none text-sm"
                      >
                        {STAT_TYPES.map((s) => (
                          <option key={s.value} value={s.value}>{s.label}</option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">Current Stat Value</label>
                      <input
                        type="number" step="0.5"
                        {...form.register("halftimeStat")}
                        data-testid="input-current-stat"
                        className="w-full h-10 px-3 rounded-lg bg-input border border-border focus:border-primary outline-none text-base font-mono"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-primary">Live Line (Over/Under)</label>
                      <input
                        type="number" step="0.5"
                        {...form.register("liveLine")}
                        data-testid="input-live-line"
                        className="w-full h-10 px-3 rounded-lg bg-primary/10 border border-primary/40 focus:border-primary outline-none text-base font-mono text-primary font-bold"
                      />
                    </div>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={calculateMutation.isPending}
                  data-testid="button-calculate"
                  className="w-full h-11 rounded-lg bg-primary text-primary-foreground font-semibold flex items-center justify-center gap-2 disabled:opacity-50 disabled:pointer-events-none"
                >
                  {calculateMutation.isPending ? (
                    <div className="w-5 h-5 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" />
                  ) : (
                    "Calculate Probability"
                  )}
                </button>
              </form>
            </div>
          </div>

          {/* RIGHT COLUMN: Results */}
          <div className="lg:col-span-7">
            {!result ? (
              <div className="h-full min-h-[400px] flex flex-col items-center justify-center border-2 border-dashed border-border/50 rounded-xl text-muted-foreground bg-card/20 p-8 text-center">
                <div className="w-16 h-16 rounded-full bg-secondary flex items-center justify-center mb-4">
                  <Activity className="w-8 h-8 text-muted-foreground/50" />
                </div>
                <h3 className="text-lg font-medium text-foreground mb-1">Awaiting Input</h3>
                <p className="max-w-sm text-sm">Select a player and opponent, enter halftime stats, then calculate.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Main Result Card */}
                <div className="bg-card border border-border rounded-xl p-6 relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-48 h-48 bg-primary/5 rounded-full blur-[60px] -translate-y-1/2 translate-x-1/2 pointer-events-none" />
                  <div className="flex flex-col md:flex-row items-center justify-between gap-6">
                    <div className="flex-1 space-y-3 z-10">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1">Live Prediction</p>
                        <div className="text-3xl font-bold tracking-tight">
                          {STAT_TYPES.find((s) => s.value === form.getValues("statType"))?.label} Line:{" "}
                          <span className="text-primary">{form.getValues("liveLine")}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 text-sm">
                        <TrendingUp className="w-4 h-4 text-muted-foreground" />
                        <span className="text-muted-foreground">
                          At half: <span className="text-foreground font-bold">{form.getValues("halftimeStat")}</span>
                          {" · "}Needs <span className="text-foreground font-bold">{(form.getValues("liveLine") - form.getValues("halftimeStat")).toFixed(1)}</span> more
                        </span>
                      </div>
                      <p className="text-muted-foreground text-xs max-w-xs">
                        Model uses foul trouble, opponent defense vs position, and blended team pace.
                      </p>
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
                    subtitle={`${result.teamPace} vs ${result.opponentPace} poss/48`}
                    icon={<Zap className="w-4 h-4" />}
                    highlight={result.paceMultiplier >= 1.02 ? "positive" : result.paceMultiplier <= 0.97 ? "negative" : "neutral"}
                  />
                </div>

                {/* Foul Trouble */}
                {form.getValues("halftimeFouls") >= 3 && (
                  <div className="bg-destructive/10 border border-destructive/30 rounded-xl p-4 flex gap-3 items-start">
                    <AlertTriangle className="w-5 h-5 text-destructive mt-0.5 flex-shrink-0" />
                    <div>
                      <h4 className="text-sm font-semibold text-destructive">Foul Trouble Alert</h4>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        {form.getValues("halftimeFouls")} fouls at half — projected 2H minutes are heavily discounted ({form.getValues("halftimeFouls") >= 4 ? "55%" : "30%"} reduction). Bench time likely.
                      </p>
                    </div>
                  </div>
                )}

                {/* Pace insight */}
                {form.getValues("halftimeScore") && (
                  <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 flex gap-3 items-start">
                    <Zap className="w-5 h-5 text-yellow-500 mt-0.5 flex-shrink-0" />
                    <div>
                      <h4 className="text-sm font-semibold text-yellow-600 dark:text-yellow-400">Live Pace Active</h4>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        Game score {form.getValues("halftimeScore")} blended with team pace history for a {result.paceLabel.toLowerCase()} ({(result.paceMultiplier * 100 - 100).toFixed(1)}% vs avg) projection.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
