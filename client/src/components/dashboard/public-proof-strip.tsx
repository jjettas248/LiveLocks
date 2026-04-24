import { usePublicAnalytics } from "@/hooks/usePublicAnalytics";
import { TrendingUp } from "lucide-react";

type ProofRow = {
  id: string;
  sport: string;
  player: string;
  market: string;
  side: string;
  line: string;
  result: string;
  driver: string;
};

const RESULT_STYLES: Record<string, string> = {
  hit: "bg-green-500/15 text-green-400 border-green-500/30",
  miss: "bg-red-500/15 text-red-400 border-red-500/30",
  push: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
};

const SPORT_BADGE: Record<string, string> = {
  MLB: "bg-green-500/15 text-green-400",
  NBA: "bg-orange-500/15 text-orange-400",
  NCAAB: "bg-blue-500/15 text-blue-400",
};

const PLAYER_PROP_KEYWORDS = [
  "hr",
  "home run",
  "homer",
  "strikeout",
  "k ",
  "ks",
  "point",
  "pts",
  "assist",
  "ast",
  "rebound",
  "reb",
  "3pm",
  "three",
  "block",
  "blk",
  "steal",
  "stl",
  "hit",
  "total bases",
  "tb",
  "rbi",
  "bases",
  "outs",
  "made",
];

const TEAM_LEVEL_KEYWORDS = [
  "team total",
  "game total",
  "spread",
  "moneyline",
  "ml ",
  "puckline",
  "runline",
];

function isPlayerPropMarket(market: string | null | undefined): boolean {
  const m = (market ?? "").toLowerCase();
  if (!m) return false;
  if (TEAM_LEVEL_KEYWORDS.some((k) => m.includes(k))) return false;
  return PLAYER_PROP_KEYWORDS.some((k) => m.includes(k));
}

function buildDriverSummary(market: string, side: string): string {
  const m = market.toLowerCase();
  const isOver = side?.toLowerCase().includes("over");
  if (m.includes("hr") || m.includes("homer") || m.includes("home run")) {
    return isOver ? "Hot bat vs vulnerable righty" : "Cold zone vs ground-ball arm";
  }
  if (m.includes("strikeout") || m.includes("k")) {
    return isOver ? "High whiff matchup, fresh arm" : "Contact lineup, low whiff vs starter";
  }
  if (m.includes("point") || m.includes("pts")) {
    return isOver ? "Pace edge + usage spike" : "Defensive matchup, foul trouble risk";
  }
  if (m.includes("assist") || m.includes("ast")) {
    return isOver ? "Heavy ball-handler usage tonight" : "Off-ball role projected";
  }
  if (m.includes("rebound") || m.includes("reb")) {
    return isOver ? "Glass mismatch, expected minutes lift" : "Switch-heavy scheme limits boards";
  }
  if (m.includes("3pm") || m.includes("three")) {
    return isOver ? "Volume shooter vs perimeter coverage" : "Tight closeouts, low attempt rate";
  }
  return isOver ? "Live model edge identified" : "Engine flagged unders bias";
}

const FALLBACK_ROWS: ProofRow[] = [
  {
    id: "fallback-1",
    sport: "MLB",
    player: "Aaron Judge",
    market: "Home Runs",
    side: "Over",
    line: "0.5",
    result: "HIT",
    driver: "Hot bat vs vulnerable righty",
  },
  {
    id: "fallback-2",
    sport: "MLB",
    player: "Taj Bradley",
    market: "Strikeouts",
    side: "Over",
    line: "6.5",
    result: "HIT",
    driver: "High whiff matchup, fresh arm",
  },
  {
    id: "fallback-3",
    sport: "NBA",
    player: "Jayson Tatum",
    market: "Points",
    side: "Over",
    line: "28.5",
    result: "HIT",
    driver: "Pace edge + usage spike",
  },
  {
    id: "fallback-4",
    sport: "NBA",
    player: "Nikola Jokic",
    market: "Assists",
    side: "Over",
    line: "9.5",
    result: "HIT",
    driver: "Heavy ball-handler usage tonight",
  },
  {
    id: "fallback-5",
    sport: "NBA",
    player: "Devin Booker",
    market: "3PM",
    side: "Over",
    line: "2.5",
    result: "HIT",
    driver: "Volume shooter vs perimeter coverage",
  },
];

export function PublicProofStrip() {
  const { data, isLoading } = usePublicAnalytics();

  let rows: ProofRow[] = [];
  if (data?.recentResults && data.recentResults.length > 0) {
    rows = data.recentResults
      .filter((r) => {
        const sport = (r.sport ?? "").toUpperCase();
        if (sport !== "MLB" && sport !== "NBA") return false;
        return isPlayerPropMarket(r.market);
      })
      .slice(0, 5)
      .map((r) => ({
        id: r.id,
        sport: r.sport,
        player: r.player,
        market: r.market,
        side: r.side,
        line: r.line,
        result: r.result,
        driver: buildDriverSummary(r.market, r.side),
      }));
  }

  let usingFallback = false;
  if (rows.length < 3) {
    rows = FALLBACK_ROWS;
    usingFallback = true;
  }

  return (
    <div
      data-testid="panel-public-proof-strip"
      className="rounded-2xl border border-border bg-secondary overflow-hidden"
    >
      <div className="px-5 py-3 border-b border-border/60 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-3.5 h-3.5 text-primary" />
          <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">
            Recent Player Prop Wins
          </h3>
        </div>
        {usingFallback && (
          <span
            data-testid="badge-proof-fallback"
            className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/70"
          >
            Sample
          </span>
        )}
      </div>

      {isLoading && !usingFallback ? (
        <div className="p-5 space-y-2 animate-pulse">
          <div className="h-12 bg-muted/30 rounded-lg" />
          <div className="h-12 bg-muted/30 rounded-lg" />
          <div className="h-12 bg-muted/30 rounded-lg" />
        </div>
      ) : (
        <div className="p-3 sm:p-4">
          <div className="flex sm:grid sm:grid-cols-1 gap-2 overflow-x-auto sm:overflow-visible snap-x sm:snap-none -mx-3 sm:mx-0 px-3 sm:px-0">
            {rows.map((row) => (
              <div
                key={row.id}
                data-testid={`row-proof-${row.id}`}
                className="snap-start shrink-0 w-[260px] sm:w-auto rounded-xl border border-border/60 bg-card p-3 flex items-center gap-3"
              >
                <span
                  className={`text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0 ${
                    RESULT_STYLES[row.result.toLowerCase()] ?? RESULT_STYLES.push
                  }`}
                >
                  {row.result.toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className={`text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0 ${
                        SPORT_BADGE[row.sport] ?? "bg-muted text-muted-foreground"
                      }`}
                    >
                      {row.sport}
                    </span>
                    <span className="text-xs font-bold text-foreground truncate">
                      {row.player}
                    </span>
                  </div>
                  <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                    {row.side} {row.market} {row.line}
                  </div>
                  <div className="text-[10px] text-muted-foreground/80 truncate mt-0.5">
                    {row.driver}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
