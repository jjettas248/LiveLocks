// ─────────────────────────────────────────────────────────────────────────────
// Mound Radar — canonical types
//
// Additive, MLB-only module that identifies *pre-game* pitcher targets from
// today's probable starters. Pitcher-positive markets ONLY (strikeouts, outs
// recorded) — no "allowed" markets (hits/walks/HR/earned-runs allowed).
//
// Hard isolation rules (mirrors pregamePowerRadar/types.ts intent, CLAUDE.md §3.1):
//   • Independent from server/mlb/pregamePowerRadar/** — no shared scoring
//     weights, no shared driver logic, no shared type imports.
//   • Does not mutate the live HR engine, probability math, bus, lifecycle, ROI.
//   • Does NOT register signals through LiveSignalBus — pregame-only read surface.
//   • Reads upstream data from shared MLB data services/caches directly.
//   • Missing data degrades to unavailable/suppressed — never fabricated.
// ─────────────────────────────────────────────────────────────────────────────

/** Pre-game pitcher tiers. Mirrors the shape of Plate's tier ladder but is its own type. */
export type MoundTier = "track" | "watch" | "strong" | "elite" | "nuclear";

/** Markets the Mound can tag. Pitcher-positive only — never an "allowed" market. */
export type MoundMarket = "pitcher_strikeouts" | "pitcher_outs";

/**
 * Runtime mirror of MoundMarket, co-located with the type so callers have one
 * source of truth for the allowlist instead of inline duplicates. The
 * `satisfies` check catches an INVALID entry being added here (one that isn't
 * a MoundMarket) at compile time; it can't catch a NEW MoundMarket value
 * being forgotten here (TS has no built-in tuple-vs-union exhaustiveness
 * check), so a future MoundMarket addition still requires updating this list
 * by hand — but at least there is only one list to update, not several.
 */
export const MOUND_MARKETS = ["pitcher_strikeouts", "pitcher_outs"] as const satisfies readonly MoundMarket[];

export type MoundLineupStatus = "confirmed" | "projected" | "unconfirmed";
export type MoundWeatherStatus = "confirmed" | "estimated" | "roof" | "unknown";
export type MoundGameStatus =
  | "scheduled"
  | "pre"
  | "live"
  | "final"
  | "postponed"
  | "delayed"
  | "unknown";
export type MoundSignalStatus = "active" | "locked" | "expired" | "graded";

export interface MoundDriver {
  key: string;
  label: string;
  direction: "positive" | "negative" | "neutral";
  evidence?: string;
  weight?: number;
}

export interface MoundParkContext {
  venueName: string | null;
  temperatureF: number | null;
  windMph: number | null;
  windDirectionLabel: string | null;
  runEnvironmentLabel:
    | "Run Suppression"
    | "Neutral Air"
    | "Neutral Conditions"
    | "Conditions Unavailable";
  runEnvironmentType: "suppress" | "neutral" | "unknown";
  driverText?: string | null;
}

export interface MoundMarketSetup {
  market: MoundMarket;
  setupScore: number;
  /** Exactly 3 grades — see marketTagger.ts's marketSetupLabel(). No "Solid"/"Watch" middle ground. */
  setupLabel: "Elite" | "Strong" | "Weak";
  isPrimary: boolean;
}

/** Best-available sportsbook line for pitcher_strikeouts. Mirrors PregameMarketEdgeContext's shape but is its own type. Display-only — never feeds score10/tier. */
export interface MoundMarketEdgeContext {
  line?: number;
  odds?: number;
  impliedProbability?: number;
  sportsbook?: string;
  oddsUpdatedAt?: string;
}

export interface MoundDiagnostics {
  pitcherSkillScore: number | null;
  opponentKProfileScore: number | null;
  workloadScore: number | null;
  runEnvironmentScore: number | null;
  recentFormScore: number | null;
  marketFitScore: number | null;
  /** Informational only (contactRisk.ts) — never feeds score10/tier. Null when handedness splits are unavailable. */
  contactRiskScore: number | null;
  riskPenalty: number;

  appliedDrivers: string[];
  appliedWarnings: string[];

  dataCoverageScore: number;
  finalScoreCap?: number;
  finalScoreBeforeCaps: number;
  finalScoreAfterCaps: number;
  publicTier: MoundTier;

  suppressed: boolean;
  suppressedReasons: string[];

  sourceFreshness: {
    lineupUpdatedAt?: string | null;
    weatherUpdatedAt?: string | null;
    pitcherStatsUpdatedAt?: string | null;
  };

  rawInputsAvailable: {
    confirmedStarter: boolean;
    confirmedOpposingLineup: boolean;
    pitcherSeasonStats: boolean;
    pitcherHandednessSplits: boolean;
    pitcherRecentStarts: boolean;
    /** v2 — Savant SwStr%/CSW%/whiff-by-family (aggregatePitcherStuffMetrics). */
    pitcherStuffMetrics: boolean;
    park: boolean;
    weather: boolean;
  };
}

export interface MoundSignal {
  signalId: string; // `mlb-mound:${sessionDate}:${gameId}:${pitcherId}` — self-namespaced, never collides with the live bus's ${sport}:${gameId}:${actorId}:${market}:${side} scheme
  sport: "mlb";
  engine: "mound_radar";

  sessionDate: string; // slateDateET()
  gameId: string;
  gameDate: string;
  startsAt: string | null;
  generatedAt: string;
  buildId: string;

  pitcherId: string;
  pitcherName: string;
  team: string;
  opponent: string;
  throws: "L" | "R" | null;

  opposingLineupConfirmed: boolean;
  opposingLineupLabel: string | null; // e.g. "vs TB projected lineup"

  primaryMarket: MoundMarket;
  marketTags: MoundMarket[];
  marketScores: Partial<Record<MoundMarket, number>>;
  marketSetups: MoundMarketSetup[];

  parkContext: MoundParkContext | null;

  score10: number;
  tier: MoundTier;
  /** Stamped once at build time (moundDirection.ts), never recomputed at grading time or on the client — the settlement rule (deriveMoundOutcome) grades against exactly this value. Backed by a dedicated, sticky-once-"fade" DB column (storage.ts) — not embedded in diagnostics, which is wholesale-overwritten on every upsert. */
  moundDirection: import("./moundDirection").MoundDirection;

  drivers: MoundDriver[];
  warnings: string[];
  tags: string[];

  lineupStatus: MoundLineupStatus; // confirmation status of the OPPOSING lineup
  weatherStatus: MoundWeatherStatus;
  gameStatus: MoundGameStatus;
  firstPitchLockEligible: boolean;
  lockedAt: string | null;

  hasMarketLine: boolean;
  isOfficialPlay: false;
  isPregameTarget: true;

  /** Best-available real sportsbook line for pitcher_strikeouts, when posted. Null pregame before books post a line — never fabricated. */
  marketEdgeContext: MoundMarketEdgeContext | null;
  /** Data-derived strikeout projection: projectedStrikeoutsFromKPer9(kPer9) (scoreUtils.ts) — the identical function moundOutcomeAttribution.ts calls for the win/loss settlement baseline, so this can never drift from the number that decides a mound_win. Null when kPer9 is unavailable. THE SETTLEMENT BASELINE — never enrich this field itself. */
  projectedStrikeouts: number | null;
  /** Display-only enrichment (matchupAdjustedKs.ts): blends current + prior-2-season K/9, opponent lineup platoon K-rate, aggregate BvP, run environment, and recent-start K trend. Never feeds score10/tier/drivers/market selection and never used by moundOutcomeAttribution.ts's settlement logic — projectedStrikeouts above remains the sole grading baseline. Null when kPer9 is unavailable. */
  matchupAdjustedStrikeouts: number | null;

  status: MoundSignalStatus;
  suppressed: boolean;
  suppressedReasons: string[];

  outcomes?: MoundOutcome | null;
  everPubliclyFlagged: boolean;
  /** Fade-track analog of everPubliclyFlagged above — see wasPubliclyFlaggedMoundFade (diagnostics.ts) for why Fade needs its own flag. Backed by its own dedicated DB column with the same SQL-level OR-upsert durability as everPubliclyFlagged (see storage.ts) — survives a server restart even if the in-memory carry-forward chain is lost. */
  everPubliclyFlaggedFade: boolean;
  becameLiveReady: boolean;
  becameLiveFire: boolean;
  convertedLiveAt: string | null;

  diagnostics: MoundDiagnostics;
}

export interface MoundOutcome {
  finalStrikeouts?: number | null;
  finalOutsRecorded?: number | null;
  finalBaseOnBalls?: number | null;
  finalEarnedRuns?: number | null;
  resolvedAt?: string;
  // Season-baseline settlement rule attribution.
  outcome?: import("../../../../shared/moundRadarWin").MoundOutcomeType;
  userVisible?: boolean;
  seasonBaselineValue?: number | null;
}

/** Per-component scorer result. All scores are on a 0–10 scale. Mirrors Plate's ComponentScore shape but is a separate type. */
export interface ComponentScore {
  score10: number;
  available: boolean;
  drivers: MoundDriver[];
  warnings: string[];
}

/** Build response contract returned by the public + admin endpoints. */
export interface MoundRadarResponse {
  date: string;
  buildId: string;
  generatedAt: string;
  source: "memory" | "rebuilt" | "db_fallback";
  gamesScanned: number;
  signals: MoundSignal[];
  diagnostics: {
    starterCoverage: number;
    weatherCoverage: number;
    pitcherCoverage: number;
    lineupCoverage: number;
    totalPitchersEvaluated: number;
    publicSignals: number;
    suppressedSignals: number;
    topSuppressionReasons: Array<{ reason: string; count: number }>;
  };
}
