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
  /** 4 grades — see marketTagger.ts's marketSetupLabel(). "Solid" is the full middle band so an ordinary setup doesn't flatten to "Weak". */
  setupLabel: "Elite" | "Strong" | "Solid" | "Weak";
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

  /**
   * Frozen prediction-time evaluation snapshots (research instrumentation —
   * Phase 1, see evaluationSnapshot.ts). Additive, optional: absent on rows
   * persisted before this instrumentation shipped. Never read by scoring,
   * qualification, or public sorting (diagnostics.ts) — measurement only.
   * Independent module from Plate's own evaluation types per this module's
   * isolation convention (no shared type imports).
   */
  evaluation?: MoundEvaluationRecord;
}

/** One frozen read of a candidate's champion state, taken at a specific build cycle. */
export interface MoundEvaluationSnapshot {
  frozenAt: string;
  buildId: string;
  /** Size of the full candidate population this signal's rank was computed against. */
  candidatePoolSize: number;
  champion: {
    score10: number;
    tier: MoundTier;
    componentScores: {
      pitcherSkillScore: number | null;
      opponentKProfileScore: number | null;
      workloadScore: number | null;
      runEnvironmentScore: number | null;
      recentFormScore: number | null;
    };
    marketScores: Partial<Record<MoundMarket, number>>;
    drivers: MoundDriver[];
    rank: {
      holistic: number;
      byMarket: Partial<Record<MoundMarket, number>>;
    };
    dataCoverageScore: number;
    lineupStatus: MoundLineupStatus;
    weatherStatus: MoundWeatherStatus;
    /**
     * The PRIMARY Follow/Fade grading target — the same season-rate-derived
     * baseline moundOutcomeAttribution.ts's seasonBaseline() already computes
     * in production, captured once here at build time instead of refetched
     * live at grading time. Never a sportsbook line — see postedLine below.
     */
    frozenProductionBaseline: {
      strikeouts: { value: number | null };
      outs: { value: number | null };
    };
    /**
     * Evaluation-metadata-only sportsbook line (never feeds scoring,
     * qualification, direction, or the champion outcome definition).
     * Strikeouts has a real fetch path; Outs has none today — always
     * unavailable, never fabricated or cross-substituted from Strikeouts.
     */
    postedLine: {
      strikeouts: { line: number | null; lineUnavailableReason: string | null; sourceTimestamp: string | null };
      outs: { line: number | null; lineUnavailableReason: string | null; sourceTimestamp: string | null };
    };
    /** Prediction-time projections, for the projection-error measurement only (§7b measurement 3). */
    predictionTimeProjections: {
      matchupAdjustedStrikeouts: number | null;
    };
  };
}

/**
 * Every evaluated candidate (including suppressed ones) gets a record.
 * `finalPregameSnapshot` is NOT guaranteed non-null — see
 * `finalPregameUnavailableReason`. Snapshot availability is independent of
 * any per-market data-quality concept.
 */
export interface MoundEvaluationRecord {
  /** Written exactly once, at genuine nonpublic→public transition (either direction), and only while the signal is still unlocked. Never overwritten after. */
  firstPublicSnapshot: MoundEvaluationSnapshot | null;
  firstPublicUnavailableReason:
    | "not_yet_public"
    | "instrumentation_started_after_surface"
    /** The signal genuinely became public for the first time, but only AFTER it had already locked — there is no legitimate pregame moment to freeze, so no snapshot is minted. */
    | "became_public_after_lock"
    | null;
  /** Which direction first went public. "null" when unresolved after a same-cycle Follow+Fade conflict. */
  firstPublicDirection: "follow" | "fade" | null;
  /** True iff Follow and Fade both transitioned public in the same build cycle — see evaluationSnapshot.ts. */
  directionConflict: boolean;
  /** Refreshed every pre-lock cycle; frozen permanently once locked. */
  finalPregameSnapshot: MoundEvaluationSnapshot | null;
  finalPregameUnavailableReason:
    | "first_seen_post_lock"
    | "legacy_row"
    | "no_complete_pregame_build"
    | null;
  /**
   * Populated once, at grading time, by moundShadowOutcomes.ts — three
   * separate measurements (§7b), independent of and never altering the
   * existing public mound_win/mound_fade_win/mound_calibration_miss
   * classification on `outcomes` above. Stays `null` while a monotonic-safe
   * live Follow win has been granted but the pitcher's outing is not yet
   * complete (`outcomes.gradedLive === true`) — computing these measurements
   * from partial, still-climbing live totals would be misleading; they are
   * only computed once, at the final counting-stat refresh once the outing
   * is genuinely complete.
   */
  gradingMeasurements?: MoundGradingMeasurements | null;
}

export interface MoundGradingMeasurements {
  /** PRIMARY: champion result vs. the frozen production baseline (never a sportsbook line). */
  championVsFrozenBaseline: {
    /** Truthful provenance — "unavailable" when neither a frozen nor a legacy baseline exists. Never claims "frozen_production_baseline" when a legacy live value was actually used. */
    baselineSource: "frozen_production_baseline" | "legacy_live_baseline" | "unavailable";
    baselineValue: number | null;
    actual: number | null;
    comparison: "over" | "under" | "push" | "unavailable";
    /** Direction-aware result using the pinned moundDirection at grading time. A null/unresolved moundDirection ALWAYS yields "unavailable" here — never falls through to Follow behavior. */
    directionResult: "follow_win" | "fade_win" | "loss" | "push" | "unavailable";
    /** First blocking reason, in priority order: no baseline value → no actual result → no resolvable direction. Null only when directionResult is a real, non-"unavailable" verdict. */
    gradingUnavailableReason: "no_baseline" | "no_actual_result" | "no_direction" | null;
  };
  /** SECONDARY: evaluation-only comparison vs. a frozen sportsbook line, when one exists. */
  actualVsFrozenLine: {
    line: number | null;
    lineUnavailableReason: string | null;
    actual: number | null;
    result: "over" | "under" | "push" | "unavailable";
  };
  /** Accuracy metric, not win/loss — projected value vs. actual. */
  projectionError: {
    projectedValue: number | null;
    actual: number | null;
    error: number | null;
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
  /** Pure pitcher-skill grade (== pitcherSkillScore/diagnostics), independent of matchup. Display-only, tagging layer — never feeds score10/tier/grading. User-facing badge text is "K Skill". */
  kStuffScore: number;
  kStuffLabel: "Elite" | "Strong" | "Solid" | "Weak";
  /** Pure platoon-matchup-fit grade (this pitcher's platoon K split weighted by today's opposing lineup handedness). Display-only, tagging layer — never feeds score10/tier/grading. User-facing badge text is "K Matchup" (internal name stays platoonKFit* — "platoon" isn't accessible user-facing terminology). */
  platoonKFitScore: number;
  platoonKFitLabel: "Elite" | "Strong" | "Solid" | "Weak";
  platoonKFitReason?: "poor handedness fit" | null;
  /** Qualitative read on the numeric strikeout projection (matchupAdjustedStrikeouts ?? projectedStrikeouts). Display-only, tagging layer — never feeds score10/tier/grading. */
  kProjectionLabel: "High" | "Good" | "Average" | "Low" | null;
  /** Line-aware, Over/Under-aware value read vs. the posted pitcher-strikeouts line only (marketEdgeContext.line) — never pitcher_outs or any other market's line. Display-only, tagging layer — never feeds score10/tier/grading. Null when no line is posted. */
  kLineValue: { side: "Over" | "Under" | "No Edge"; label: "Elite" | "Strong" | "Solid" | "Weak"; margin: number; line: number; projection: number } | null;

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
  /**
   * True while a Follow/Over mound_win was graded live (game not yet final)
   * and is still awaiting its final counting-stat refresh (see
   * moundShadowOutcomes.ts's refresh pass). False/undefined once the outcome
   * reflects the game's true final box score — either because it was graded
   * at final directly, or because the refresh pass has already run. The
   * outcome/userVisible/seasonBaselineValue that decided the win are locked
   * at live-grading time and never re-derived by the refresh — only the raw
   * counting stats (finalStrikeouts/finalOutsRecorded/etc.) get updated.
   */
  gradedLive?: boolean;
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
