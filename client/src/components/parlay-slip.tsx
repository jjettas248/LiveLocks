import { useState, useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import type { ParlayPickInput, ParlayResult, CorrelationNote } from "@shared/schema";
import { ProbabilityRing } from "./probability-ring";
import {
  X,
  ExternalLink,
  TrendingUp,
  AlertTriangle,
  CheckCircle,
  Minus,
  Trophy,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

interface ParlaySlipProps {
  picks: ParlayPickInput[];
  onRemove: (idx: number) => void;
  onClear: () => void;
}

const STAT_LABELS: Record<string, string> = {
  points: "PTS",
  rebounds: "REB",
  assists: "AST",
  steals: "STL",
  blocks: "BLK",
  pts_reb_ast: "PRA",
  pts_reb: "PR",
  pts_ast: "PA",
  reb_ast: "RA",
  stl_blk: "S+B",
};

const SPORTSBOOK_INFO: Record<string, { label: string; color: string; deeplink: (picks: ParlayPickInput[]) => string }> = {
  draftkings: {
    label: "DraftKings",
    color: "bg-[#1a6f3c] hover:bg-[#1a8f4c]",
    deeplink: () => "https://sportsbook.draftkings.com/leagues/basketball/nba",
  },
  fanduel: {
    label: "FanDuel",
    color: "bg-[#1358d0] hover:bg-[#1a6af0]",
    deeplink: () => "https://sportsbook.fanduel.com/navigation/nba",
  },
  hardrockbet: {
    label: "Hard Rock Bet",
    color: "bg-[#b8860b] hover:bg-[#d4a017]",
    deeplink: () => "https://www.hardrockbet.com/sports/basketball",
  },
};

function formatOdds(odds: number): string {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

function CorrelationBadge({ note }: { note: CorrelationNote }) {
  const isPositive = note.type === "positive";
  const isNegative = note.type === "negative";

  return (
    <div
      className={`flex items-start gap-2 p-2.5 rounded-lg text-xs border ${
        isPositive
          ? "bg-green-500/10 border-green-500/30 text-green-400"
          : isNegative
          ? "bg-red-500/10 border-red-500/30 text-red-400"
          : "bg-muted/50 border-border text-muted-foreground"
      }`}
    >
      {isPositive ? (
        <TrendingUp className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
      ) : isNegative ? (
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
      ) : (
        <Minus className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
      )}
      <div>
        <span className="font-semibold">{note.pick1} × {note.pick2}:</span>{" "}
        {note.explanation}{" "}
        <span className="font-bold">({note.multiplier > 1 ? "+" : ""}{((note.multiplier - 1) * 100).toFixed(0)}%)</span>
      </div>
    </div>
  );
}

export function ParlaySlip({ picks, onRemove, onClear }: ParlaySlipProps) {
  const [result, setResult] = useState<ParlayResult | null>(null);
  const [showCorrelations, setShowCorrelations] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const calculateParlay = useMutation({
    mutationFn: async (picks: ParlayPickInput[]): Promise<ParlayResult> => {
      const res = await fetch("/api/parlay/calculate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ picks }),
      });
      if (!res.ok) throw new Error("Failed to calculate parlay");
      return res.json();
    },
    onSuccess: (data) => setResult(data),
  });

  // Auto-calculate whenever picks change (debounced 300ms)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (picks.length >= 2) {
      debounceRef.current = setTimeout(() => calculateParlay.mutate(picks), 300);
    } else {
      setResult(null);
    }
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [picks]);

  if (picks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-center p-6">
        <Trophy className="w-10 h-10 text-muted-foreground/30 mb-3" />
        <p className="text-sm text-muted-foreground">No picks yet.</p>
        <p className="text-xs text-muted-foreground/60 mt-1">Calculate a prop then click Over or Under to add.</p>
      </div>
    );
  }

  const uniqueSportsbooks = Array.from(new Set(picks.map((p) => p.sportsbook).filter(Boolean)));

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Trophy className="w-4 h-4 text-primary" />
          <span className="font-semibold text-sm">{picks.length}-Leg Parlay</span>
        </div>
        <button
          onClick={onClear}
          className="text-xs text-muted-foreground hover:text-destructive flex items-center gap-1"
          data-testid="button-clear-parlay"
        >
          <X className="w-3 h-3" /> Clear All
        </button>
      </div>

      {/* Picks List */}
      <div className="space-y-2 mb-3">
        {picks.map((pick, idx) => (
          <div
            key={idx}
            data-testid={`parlay-pick-${idx}`}
            className="flex items-center gap-2 p-2.5 bg-secondary/50 rounded-lg border border-border/50"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-semibold text-sm text-foreground truncate">{pick.playerName}</span>
                <span className="text-xs text-muted-foreground">{pick.playerTeam}</span>
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                  pick.betDirection === "under"
                    ? "bg-red-500/10 text-red-400"
                    : "bg-emerald-500/10 text-emerald-400"
                }`}>
                  {STAT_LABELS[pick.statType] ?? pick.statType} {pick.betDirection === "under" ? "U" : "O"}{pick.line}
                </span>
                {pick.sportsbook && (
                  <span className="text-xs text-muted-foreground">
                    {SPORTSBOOK_INFO[pick.sportsbook]?.label ?? pick.sportsbook}
                    {pick.oddsAmerican ? ` (${formatOdds(pick.oddsAmerican)})` : ""}
                  </span>
                )}
                <span
                  className={`text-xs font-bold ml-auto ${
                    pick.probability >= 65
                      ? "text-green-400"
                      : pick.probability <= 35
                      ? "text-red-400"
                      : "text-yellow-400"
                  }`}
                >
                  {pick.probability.toFixed(1)}%
                </span>
              </div>
            </div>
            <button
              onClick={() => onRemove(idx)}
              data-testid={`button-remove-pick-${idx}`}
              className="text-muted-foreground hover:text-destructive flex-shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>

      {/* Calculate Button / auto-calculating indicator */}
      {calculateParlay.isPending ? (
        <div className="w-full h-10 rounded-lg bg-primary/20 border border-primary/30 text-primary/80 text-sm font-semibold flex items-center justify-center gap-2 mb-3">
          <div className="w-3.5 h-3.5 border-2 border-primary/60 border-t-transparent rounded-full animate-spin" />
          Calculating…
        </div>
      ) : (
        <button
          onClick={() => calculateParlay.mutate(picks)}
          disabled={picks.length < 2}
          data-testid="button-calculate-parlay"
          className="w-full h-10 rounded-lg bg-primary/10 border border-primary/30 text-primary font-semibold text-sm flex items-center justify-center gap-2 hover:bg-primary/20 transition-colors disabled:opacity-40 mb-3"
        >
          <Trophy className="w-4 h-4" />
          {result ? "Recalculate" : "Calculate Parlay"}
        </button>
      )}

      {/* Results */}
      {result && (
        <div className="space-y-3 flex-1 overflow-y-auto">
          {/* Probability Ring */}
          <div className="bg-card border border-border rounded-xl p-4 flex flex-col items-center">
            <ProbabilityRing
              probability={result.correlationAdjustedProbability}
              size={140}
              strokeWidth={12}
            />
            <div className="text-center mt-2">
              <div className="text-xs text-muted-foreground">Correlation-Adjusted Hit %</div>
              {result.correlationAdjustedProbability !== result.combinedProbability && (
                <div className="text-xs text-muted-foreground/60 mt-1">
                  Base: {result.combinedProbability.toFixed(1)}%
                </div>
              )}
            </div>
          </div>

          {/* Odds */}
          <div className="bg-secondary/50 rounded-xl p-3 border border-border/50">
            <div className="flex justify-between items-center">
              <span className="text-xs text-muted-foreground uppercase tracking-wider">Implied Odds</span>
              <span className={`text-xl font-bold font-mono ${result.impliedAmericanOdds > 0 ? "text-green-400" : "text-foreground"}`}>
                {formatOdds(result.impliedAmericanOdds)}
              </span>
            </div>
          </div>

          {/* Correlations */}
          {result.correlations.length > 0 && (
            <div className="space-y-1.5">
              <button
                className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground w-full"
                onClick={() => setShowCorrelations(!showCorrelations)}
                data-testid="button-toggle-correlations"
              >
                <CheckCircle className="w-3.5 h-3.5" />
                {result.correlations.length} Correlation{result.correlations.length !== 1 ? "s" : ""} Detected
                {showCorrelations ? <ChevronUp className="w-3 h-3 ml-auto" /> : <ChevronDown className="w-3 h-3 ml-auto" />}
              </button>
              {showCorrelations && (
                <div className="space-y-1.5">
                  {result.correlations.map((c, i) => (
                    <CorrelationBadge key={i} note={c} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Sportsbook Deeplinks */}
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Open Bet Slip</p>
            <p className="text-xs text-muted-foreground/60 -mt-1">
              You'll confirm and place the bet yourself on their platform.
            </p>
            {(uniqueSportsbooks.length > 0 ? uniqueSportsbooks : ["draftkings", "fanduel", "hardrockbet"]).map((sb) => {
              const info = SPORTSBOOK_INFO[sb];
              if (!info) return null;
              return (
                <a
                  key={sb}
                  href={info.deeplink(picks)}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid={`link-sportsbook-${sb}`}
                  className={`flex items-center justify-between w-full px-4 py-2.5 rounded-lg text-white font-semibold text-sm transition-colors ${info.color}`}
                >
                  <span>{info.label}</span>
                  <ExternalLink className="w-4 h-4" />
                </a>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
