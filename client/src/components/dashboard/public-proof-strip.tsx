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

// Player-prop market allow-list. Conversion proof must only render
// player-driven markets, never team totals / spreads / moneylines / 2H
// totals / game totals.
//
// Long substrings use simple `includes()` matching; short tokens (PRA,
// PR, RA, PA, TB, KS, HR, HRR, REB, AST, PTS, BLK, STL) use exact
// word-boundary matching so they don't false-positive on non-player
// markets like "Park Factor" or "Passing Yards" if those ever leak in.
const PLAYER_PROP_SUBSTRINGS = [
  "hit",
  "total bases",
  "total_bases",
  "home run",
  "home_run",
  "homer",
  "rbi",
  "bases",
  "runs scored",
  "pitcher strikeouts",
  "pitcher_strikeouts",
  "strikeout",
  "outs recorded",
  "pitcher_outs",
  "pitcher outs",
  "hits allowed",
  "hits_allowed",
  "point",
  "assist",
  "rebound",
  "3pm",
  "threes",
  "three pointer",
  "three-point",
  "block",
  "steal",
  "made threes",
];

const PLAYER_PROP_TOKENS = new Set([
  "tb",
  "hr",
  "hrr",
  "ks",
  "pts",
  "ast",
  "reb",
  "blk",
  "stl",
  "pra",
  "pr",
  "ra",
  "pa",
]);

const TEAM_LEVEL_KEYWORDS = [
  "team total",
  "team_total",
  "game total",
  "game_total",
  "spread",
  "moneyline",
  "money line",
  "ml ",
  "puckline",
  "runline",
  "1h ",
  "2h ",
  "first half",
  "second half",
  "halftime total",
];

function isPlayerPropMarket(market: string | null | undefined): boolean {
  const m = (market ?? "").toLowerCase().trim();
  if (!m) return false;
  if (TEAM_LEVEL_KEYWORDS.some((k) => m.includes(k))) return false;
  if (PLAYER_PROP_SUBSTRINGS.some((k) => m.includes(k))) return true;
  // Token match: split into word-like chunks and check the small-token set.
  const tokens = m.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((t) => PLAYER_PROP_TOKENS.has(t));
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
    // Filter to player-prop markets in MLB / NBA only.
    const candidates = data.recentResults
      .filter((r) => {
        const sport = (r.sport ?? "").toUpperCase();
        if (sport !== "MLB" && sport !== "NBA") return false;
        return isPlayerPropMarket(r.market);
      });

    // Wins-first ordering: HIT rows ranked by most recent settledAt,
    // followed by non-HIT rows by most recent settledAt. This ensures a
    // miss can never appear above a hit in the conversion proof strip
    // for free users.
    const tsOf = (r: { settledAt?: string }) => {
      const t = r.settledAt ? Date.parse(r.settledAt) : NaN;
      return Number.isFinite(t) ? t : 0;
    };
    const isHit = (r: { result: string }) => (r.result ?? "").toLowerCase() === "hit";

    const hits = candidates.filter(isHit).sort((a, b) => tsOf(b) - tsOf(a));
    const nonHits = candidates.filter((r) => !isHit(r)).sort((a, b) => tsOf(b) - tsOf(a));

    const MAX_VISIBLE = 5;
    // Prefer all-hit display when we have enough HITs (>=3) so the title
    // can honestly claim "Wins". Otherwise mix wins-first then most-recent.
    const ordered =
      hits.length >= 3
        ? hits.slice(0, MAX_VISIBLE)
        : [...hits, ...nonHits].slice(0, MAX_VISIBLE);

    rows = ordered.map((r) => ({
      id: r.id,
      sport: (r.sport ?? "").toUpperCase(),
      player: r.player,
      market: r.market,
      side: r.side,
      line: r.line,
      result: r.result,
      driver: "",
    }));
  }

  let usingFallback = false;
  if (rows.length < 3) {
    rows = FALLBACK_ROWS;
    usingFallback = true;
  }

  // Honest title: only call them "Wins" when every visible row is a hit.
  const allHits = rows.every((r) => (r.result ?? "").toLowerCase() === "hit");
  const headlineTitle = allHits ? "Recent Player Prop Wins" : "Recent Player Prop Results";

  return (
    <div
      data-testid="panel-public-proof-strip"
      className="rounded-2xl border border-border bg-secondary overflow-hidden"
    >
      <div className="px-5 py-3 border-b border-border/60 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-3.5 h-3.5 text-primary" />
          <h3
            data-testid="text-proof-headline"
            className="text-xs font-bold text-foreground uppercase tracking-wider"
          >
            {headlineTitle}
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
                  {row.driver && (
                    <div className="text-[10px] text-muted-foreground/80 truncate mt-0.5">
                      {row.driver}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
