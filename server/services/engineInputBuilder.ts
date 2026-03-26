// ── Unified Engine Input Builder ───────────────────────────────────────────────
// Assembles a standardized context object consumed by all three engines,
// replacing ad-hoc argument passing.
// Phase 2: derivedLine flag is part of the canonical contract — when true,
//          a confidence penalty of 0.9× is applied to the line for computation.
// Phase 3: sportsbookMeta carries multi-book consensus metadata.

export interface EngineContext {
  score?: { home: number; away: number };
  timeRemaining?: number;
  pace?: number;
  efficiency?: { offensiveRating?: number; defensiveRating?: number };
  usage?: number;
  matchup?: { defRatingVsPosition?: number; paceAllowed?: number };
  fatigue?: { score?: number; usageLast3Days?: number };
  weather?: { temperature?: number | null; windSpeed?: number | null; windDirection?: string | null };
}

// Phase 3 — Multi-book consensus metadata attached to every engine input
export interface SportsbookMeta {
  bestBook: string | null;
  availableBooks: string[];
  lineVariance: number | null;
  isConsensusValid: boolean;
}

export interface EngineInput {
  gameId: string;
  sport: "nba" | "ncaab" | "mlb";
  playerId?: string;
  teamId?: string;
  marketType: string;
  // canonicalLine = median across all available sportsbooks (or raw line if only one source)
  line: number | null;
  // derivedLine: true means the line was estimated (not from a real sportsbook).
  // A 0.9× confidence penalty is applied so derived lines are never treated equally.
  derivedLine: boolean;
  confidencePenalty: number;
  // Phase 4: lineSource — where the line came from
  lineSource: "sportsbook" | "inferred" | "derived";
  odds: {
    overOdds?: number | null;
    underOdds?: number | null;
    medianLine?: number | null;
    bestOverOdds?: number | null;
    bestUnderOdds?: number | null;
    lineVariance?: number | null;
    booksAvailable?: number;
    sportsbookSources?: string[];
  };
  // Phase 3: multi-book consensus metadata
  sportsbookMeta: SportsbookMeta;
  context: EngineContext;
  createdAt: number;
}

// Confidence penalty applied when using a derived (non-sportsbook) line
const DERIVED_LINE_CONFIDENCE_PENALTY = 0.9;

export function buildEngineInput(params: {
  gameId: string;
  sport: "nba" | "ncaab" | "mlb";
  playerId?: string;
  teamId?: string;
  marketType: string;
  line: number | null;
  derivedLine?: boolean;
  lineSource?: "sportsbook" | "inferred" | "derived";
  overOdds?: number | null;
  underOdds?: number | null;
  normalizedOdds?: {
    medianLine?: number | null;
    bestOverOdds?: number | null;
    bestUnderOdds?: number | null;
    lineVariance?: number | null;
    booksAvailable?: number;
    sportsbookSources?: string[];
  };
  sportsbookMeta?: Partial<SportsbookMeta>;
  context?: Partial<EngineContext>;
}): EngineInput {
  const isDerived = params.derivedLine ?? false;

  // Infer lineSource from derivedLine if not explicitly provided
  const lineSource: "sportsbook" | "inferred" | "derived" =
    params.lineSource ??
    (isDerived ? "derived" : "sportsbook");

  if (isDerived) {
    console.log(`[DERIVED LINE USED][${params.gameId}] sport=${params.sport} market=${params.marketType} line=${params.line} penalty=${DERIVED_LINE_CONFIDENCE_PENALTY}`);
  }

  const availableBooks = params.sportsbookMeta?.availableBooks ?? (params.normalizedOdds?.sportsbookSources ?? []);

  return {
    gameId: params.gameId,
    sport: params.sport,
    playerId: params.playerId,
    teamId: params.teamId,
    marketType: params.marketType,
    line: params.line,
    derivedLine: isDerived,
    confidencePenalty: isDerived ? DERIVED_LINE_CONFIDENCE_PENALTY : 1.0,
    lineSource,
    odds: {
      overOdds: params.overOdds ?? null,
      underOdds: params.underOdds ?? null,
      medianLine: params.normalizedOdds?.medianLine ?? params.line,
      bestOverOdds: params.normalizedOdds?.bestOverOdds ?? params.overOdds ?? null,
      bestUnderOdds: params.normalizedOdds?.bestUnderOdds ?? params.underOdds ?? null,
      lineVariance: params.normalizedOdds?.lineVariance ?? params.sportsbookMeta?.lineVariance ?? null,
      booksAvailable: params.normalizedOdds?.booksAvailable ?? availableBooks.length ?? (params.overOdds != null ? 1 : 0),
      sportsbookSources: availableBooks,
    },
    sportsbookMeta: {
      bestBook: params.sportsbookMeta?.bestBook ?? (availableBooks[0] ?? null),
      availableBooks,
      lineVariance: params.sportsbookMeta?.lineVariance ?? params.normalizedOdds?.lineVariance ?? null,
      isConsensusValid: params.sportsbookMeta?.isConsensusValid ?? availableBooks.length >= 2,
    },
    context: {
      score: params.context?.score,
      timeRemaining: params.context?.timeRemaining,
      pace: params.context?.pace,
      efficiency: params.context?.efficiency,
      usage: params.context?.usage,
      matchup: params.context?.matchup,
      fatigue: params.context?.fatigue,
      weather: params.context?.weather,
    },
    createdAt: Date.now(),
  };
}
