import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { calculateProbabilitySchema, type CalculateProbabilityRequest } from "@shared/schema";
import { usePlayers, useTeams, useCalculateProbability } from "@/hooks/use-nba";
import { ProbabilityRing } from "@/components/probability-ring";
import { StatCard } from "@/components/stat-card";
import { 
  Activity, 
  Clock, 
  AlertTriangle, 
  Target, 
  ShieldAlert, 
  TrendingUp,
  ChevronDown
} from "lucide-react";

export default function Dashboard() {
  const { data: players, isLoading: isPlayersLoading } = usePlayers();
  const { data: teams, isLoading: isTeamsLoading } = useTeams();
  const calculateMutation = useCalculateProbability();

  const form = useForm<CalculateProbabilityRequest>({
    resolver: zodResolver(calculateProbabilitySchema),
    defaultValues: {
      halftimeMinutes: 0,
      halftimeFouls: 0,
      halftimeStat: 0,
      liveLine: 0,
      statType: "points",
    }
  });

  const onSubmit = (data: CalculateProbabilityRequest) => {
    calculateMutation.mutate(data);
  };

  const isLoading = isPlayersLoading || isTeamsLoading;

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin w-12 h-12 border-4 border-primary border-t-transparent rounded-full"></div>
      </div>
    );
  }

  const result = calculateMutation.data;

  return (
    <div className="min-h-screen pb-20 relative overflow-hidden bg-grid-pattern">
      {/* Header */}
      <header className="border-b border-border/40 bg-background/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shadow-[0_0_15px_rgba(59,130,246,0.5)]">
              <Activity className="w-5 h-5 text-primary-foreground" />
            </div>
            <h1 className="text-xl font-display font-bold tracking-tight">
              NBA Live Line <span className="text-primary text-glow">Predictor</span>
            </h1>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          
          {/* LEFT COLUMN: Input Form */}
          <div className="lg:col-span-5 space-y-6">
            <div className="bg-card border border-border shadow-2xl shadow-black/40 rounded-2xl p-6 relative overflow-hidden">
              {/* Decorative accent line */}
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary to-transparent"></div>
              
              <div className="mb-6">
                <h2 className="text-2xl font-display font-semibold">Matchup Details</h2>
                <p className="text-muted-foreground text-sm mt-1">Enter halftime stats to calculate 2H probability.</p>
              </div>

              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
                {/* Player & Opponent */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-foreground">Player</label>
                    <div className="relative">
                      <select 
                        {...form.register("playerId")}
                        className="w-full h-11 px-4 rounded-xl bg-input border border-border focus:border-primary focus:ring-1 focus:ring-primary outline-none appearance-none transition-colors text-sm"
                      >
                        <option value="">Select Player...</option>
                        {players?.map(p => (
                          <option key={p.id} value={p.id}>{p.name} ({p.team} - {p.position})</option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                    </div>
                    {form.formState.errors.playerId && (
                      <p className="text-xs text-destructive">{form.formState.errors.playerId.message}</p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium text-foreground">Opponent</label>
                    <div className="relative">
                      <select 
                        {...form.register("opponentTeam")}
                        className="w-full h-11 px-4 rounded-xl bg-input border border-border focus:border-primary focus:ring-1 focus:ring-primary outline-none appearance-none transition-colors text-sm"
                      >
                        <option value="">Select Opponent...</option>
                        {teams?.map(t => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                    </div>
                    {form.formState.errors.opponentTeam && (
                      <p className="text-xs text-destructive">{form.formState.errors.opponentTeam.message}</p>
                    )}
                  </div>
                </div>

                {/* Halftime Situation */}
                <div className="p-4 rounded-xl bg-secondary/50 border border-border/50 space-y-4">
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                    <Clock className="w-4 h-4" /> Halftime Situation
                  </h3>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-muted-foreground">Minutes Played</label>
                      <input 
                        type="number" step="0.1"
                        {...form.register("halftimeMinutes")}
                        className="w-full h-10 px-3 rounded-lg bg-input border border-border focus:border-primary focus:ring-1 focus:ring-primary outline-none text-lg font-mono"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-muted-foreground">Fouls Committed</label>
                      <input 
                        type="number"
                        {...form.register("halftimeFouls")}
                        className="w-full h-10 px-3 rounded-lg bg-input border border-border focus:border-primary focus:ring-1 focus:ring-primary outline-none text-lg font-mono"
                      />
                    </div>
                  </div>
                </div>

                {/* The Line */}
                <div className="p-4 rounded-xl bg-secondary/50 border border-border/50 space-y-4">
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                    <Target className="w-4 h-4" /> The Line
                  </h3>
                  
                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-1 space-y-2">
                      <label className="text-xs font-medium text-muted-foreground">Stat Type</label>
                      <div className="relative">
                        <select 
                          {...form.register("statType")}
                          className="w-full h-10 pl-3 pr-8 rounded-lg bg-input border border-border focus:border-primary focus:ring-1 focus:ring-primary outline-none appearance-none text-sm"
                        >
                          <option value="points">Points</option>
                          <option value="rebounds">Rebounds</option>
                          <option value="assists">Assists</option>
                        </select>
                        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                      </div>
                    </div>
                    <div className="col-span-1 space-y-2">
                      <label className="text-xs font-medium text-muted-foreground">Current Stat</label>
                      <input 
                        type="number" step="0.5"
                        {...form.register("halftimeStat")}
                        className="w-full h-10 px-3 rounded-lg bg-input border border-border focus:border-primary focus:ring-1 focus:ring-primary outline-none text-lg font-mono"
                      />
                    </div>
                    <div className="col-span-1 space-y-2">
                      <label className="text-xs font-medium text-muted-foreground text-primary">Live Line</label>
                      <input 
                        type="number" step="0.5"
                        {...form.register("liveLine")}
                        className="w-full h-10 px-3 rounded-lg bg-primary/10 border border-primary/30 focus:border-primary focus:ring-1 focus:ring-primary outline-none text-lg font-mono text-primary font-bold"
                      />
                    </div>
                  </div>
                </div>

                <button 
                  type="submit"
                  disabled={calculateMutation.isPending}
                  className="w-full h-12 rounded-xl bg-primary text-primary-foreground font-semibold text-lg hover-elevate active-elevate-2 flex items-center justify-center gap-2 disabled:opacity-50 disabled:pointer-events-none transition-all"
                >
                  {calculateMutation.isPending ? (
                    <div className="w-5 h-5 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin"></div>
                  ) : (
                    <>Calculate Probability</>
                  )}
                </button>
              </form>
            </div>
          </div>

          {/* RIGHT COLUMN: Results Dashboard */}
          <div className="lg:col-span-7">
            {!result ? (
              <div className="h-full min-h-[400px] flex flex-col items-center justify-center border-2 border-dashed border-border/50 rounded-2xl text-muted-foreground bg-card/20 backdrop-blur-sm p-8 text-center">
                <div className="w-20 h-20 rounded-full bg-secondary flex items-center justify-center mb-6">
                  <Activity className="w-10 h-10 text-muted-foreground/50" />
                </div>
                <h3 className="text-xl font-display font-medium text-foreground mb-2">Awaiting Input</h3>
                <p className="max-w-md">Enter the matchup details and halftime stats on the left to calculate the live probability.</p>
              </div>
            ) : (
              <div className="space-y-6 animation-fade-in">
                {/* Main Result Card */}
                <div className="bg-card border border-border shadow-2xl shadow-black/40 rounded-2xl p-8 relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 rounded-full blur-[80px] -translate-y-1/2 translate-x-1/2 pointer-events-none"></div>
                  
                  <div className="flex flex-col md:flex-row items-center justify-between gap-8">
                    <div className="flex-1 text-center md:text-left space-y-4 z-10">
                      <div>
                        <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-1">Live Prediction</h2>
                        <div className="text-4xl font-display font-bold tracking-tight text-foreground">
                          {form.getValues("statType").charAt(0).toUpperCase() + form.getValues("statType").slice(1)} Line: <span className="text-primary">{form.getValues("liveLine")}</span>
                        </div>
                      </div>
                      
                      <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-secondary border border-border/50">
                        <TrendingUp className="w-4 h-4 text-muted-foreground" />
                        <span className="text-sm font-medium">Currently at <span className="text-foreground font-bold">{form.getValues("halftimeStat")}</span></span>
                      </div>
                      
                      <p className="text-muted-foreground text-sm max-w-sm">
                        Based on historical minute rotations, foul trouble severity, and opponent defensive rating against the position.
                      </p>
                    </div>

                    <div className="flex-shrink-0 z-10 bg-background/50 p-6 rounded-3xl border border-border/50 shadow-inner">
                      <ProbabilityRing probability={result.probability} />
                    </div>
                  </div>
                </div>

                {/* Factors Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <StatCard 
                    title="Expected Total" 
                    value={result.expectedTotal.toFixed(1)} 
                    subtitle={`Needed: ${form.getValues("liveLine")}`}
                    icon={<Target className="w-5 h-5" />}
                    highlight={result.expectedTotal >= form.getValues("liveLine") ? "positive" : "negative"}
                  />
                  
                  <StatCard 
                    title="Proj. 2H Minutes" 
                    value={result.projectedSecondHalfMinutes.toFixed(1)} 
                    subtitle={`1H played: ${form.getValues("halftimeMinutes")}`}
                    icon={<Clock className="w-5 h-5" />}
                    highlight={result.projectedSecondHalfMinutes > form.getValues("halftimeMinutes") ? "positive" : "neutral"}
                  />
                  
                  <StatCard 
                    title="Defensive Matchup" 
                    value={`${result.defenseMultiplier > 1 ? '+' : ''}${((result.defenseMultiplier - 1) * 100).toFixed(1)}%`} 
                    subtitle="Vs. Position Average"
                    icon={<ShieldAlert className="w-5 h-5" />}
                    highlight={result.defenseMultiplier > 1 ? "positive" : "negative"}
                  />
                </div>
                
                {/* Warning / Insight Panel */}
                {form.getValues("halftimeFouls") >= 3 && (
                  <div className="bg-destructive/10 border border-destructive/30 rounded-xl p-4 flex gap-4 items-start">
                    <div className="mt-0.5">
                      <AlertTriangle className="w-5 h-5 text-destructive" />
                    </div>
                    <div>
                      <h4 className="text-sm font-semibold text-destructive">Foul Trouble Alert</h4>
                      <p className="text-sm text-muted-foreground mt-1">
                        Player has {form.getValues("halftimeFouls")} fouls. Our model heavily discounts projected 2H minutes. Early 3rd quarter substitutions are highly probable.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          
        </div>
      </main>
      
      <style>{`
        .animation-fade-in {
          animation: fadeIn 0.5s ease-out forwards;
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
