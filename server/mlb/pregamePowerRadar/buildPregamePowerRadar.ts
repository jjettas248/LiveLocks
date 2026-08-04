// Pre-Game Power Radar — build orchestration.
//
// Scans today's slate, assembles per-batter inputs from shared MLB data
// services (never fabricated), scores them, and writes the in-memory snapshot.
// Guarded against concurrent builds; everything try/catch so it can never crash
// runtime. DB persistence (Phase 2) is invoked via an optional sink callback so
// this module stays free of storage imports.

import { randomUUID } from "crypto";
import { slateDateET } from "../../utils/dateUtils";
import { discoverTodaysGames } from "../gameDiscoveryService";
import {
  getStartingLineup,
  getStartingPitcher,
  getPlayer,
  updateStartingLineups,
  updateStartingPitchers,
} from "../rosterService";
import { fetchBaseballSavantData, getMarketParkFactor, isVenueIndoors, isVenueResolved } from "../dataSources";
import {
  fetchPitcherHandednessSplits,
  fetchBatterHandednessSplits,
  fetchRecentContactEventsForBatters,
  fetchPitcherRecentStarts,
  syncWeather,
  syncOpenMeteoWeather,
  syncBvPMatchup,
  syncBatterOrderSplits,
  mlbGameCache,
  mlbPlayerCache,
} from "../dataPullService";
// Reuses Mound Radar's already-built, already-tested pure contact-quality
// aggregator (no I/O of its own — operates on an already-fetched Savant CSV)
// so the barrel/hard-hit/fly-ball-allowed signal isn't reimplemented a second
// time. This is a one-way, leaf-to-leaf dependency between two sibling MLB
// pregame engines (not the NBA/MLB/NCAAB cross-sport boundary CLAUDE.md
// forbids) — server/mlb/dataSources.ts documents itself as the shape's sole
// owner and must never import back from Mound.
import { aggregateRawPitcherContactSnapshot } from "../pregame/mound/rawPitcherContactSnapshot";
import type {
  PregamePowerSignal,
  PregameGameStatus,
  PregameLineupStatus,
  PregameWeatherStatus,
  PowerDriver,
  PregameParkContext,
} from "./types";
import { PLATE_CHAMPION_POLICY } from "./modelVersions/plateChampionJul20";
import { PLATE_CHALLENGER_POLICY } from "./modelVersions/plateChallengerCurrent";
import { isPlateShadowChallengerEnabled } from "./modelVersions/plateShadowFlags";
import { evaluatePlateModel } from "./evaluatePlateModel";
import {
  freezePlateInput,
  hashFrozenPlateInput,
  RESEARCH_UNCOLLECTED,
  type FrozenPlateInput,
} from "./frozenPlateInput";
import {
  buildPlateModelComparison,
  shouldLogPlateDelta,
  type PlateModelComparisonRecord,
} from "./plateModelComparison";
import { countPositiveDrivers, driverKeysForUniverse } from "./modelVersions/plateDriverUniverse";
import { computeBatterPowerProfile, type BatterPowerInputs } from "./batterPowerProfile";
import type { IsoAssessment } from "./isoAssessment";
import { buildIsoSlateAudit, recordAndLogIsoSlateAudit } from "./isoDistributionAudit";
import { isPublicPregameSignal } from "./diagnostics";
import { computePitcherVulnerability } from "./pitcherVulnerability";
import { computePitcherOrderSplit } from "./pitcherOrderSplit";
import { computeBatterOrderSplit } from "./batterOrderSplit";
import { computeMatchupFit } from "./matchupFit";
import { round1 as round1Score } from "./scoreUtils";
import { computeParkWeatherScore } from "./parkWeatherScore";
import { hydratePregamePlayerParkWindFit } from "./playerParkWindFit";
import { computeLineupOpportunity } from "./lineupOpportunity";
import { computeNearHrRecentForm, type RecentContactEventRow } from "./nearHrRecentForm";
import { computeMarketTags } from "./marketTagger";
import { composePregameScore } from "./scoring";
import {
  computeAttackEnvironment,
  getParkDirection,
  appendAttackEnvironmentDrivers,
  ATTACK_ENVIRONMENT_HOSTILE_SUPPRESSION_REASON,
} from "./attackEnvironment";
import { buildGradeFactorSummary } from "./gradeFactorSummary";
import { auditPrimaryMarketFit } from "./marketFitAudit";
import { carryForwardGradedState, carryForwardDroppedFromLineup } from "./gradedStateCarry";
import { applyEvaluationSnapshots } from "./evaluationSnapshot";
import {
  getSnapshot,
  setSnapshot,
  type PregamePowerSnapshot,
} from "./pregamePowerRadarStore";
import { buildPitchTypeInteractionInputsFromSavant } from "./pitchFamilyMatchup";
import { getPullSideParkGeometry } from "./parkDimensions";
import { isPlateHrV2ForwardCaptureEnabled } from "./hrProbabilityV2/plateHrV2CaptureFlags";
import {
  capturePlateHrV2Candidate,
  flushPlateHrV2Captures,
  captureSufficientStatsIfNeeded,
  flushPlateHrV2SufficientStats,
  plateHrV2SufficientStatsId,
  type PlateHrV2CaptureRow,
  type PlateHrV2SufficientStatsCaptureRow,
} from "./hrProbabilityV2/plateHrV2ForwardCapture";
import { assemblePlateHrV2EvidenceDescriptors } from "./hrProbabilityV2/plateHrV2SnapshotCapture";
import { PLATE_HR_V2_FEATURES_CURRENT } from "./hrProbabilityV2/plateHrV2FeatureContract";
import { buildRecentContactFormEvidence } from "./hrProbabilityV2/recentContactFormEvidence";

let isPregamePowerRadarBuildRunning = false;

// Dedup state for [PREGAME_MARKET_FIT_AUDIT] — observability-only, never read
// by scoring/eligibility. Logged once per build as a SINGLE aggregated line
// (not per-signal), and only when the set of flagged signalIds actually
// changed since the previous build, so an unchanged condition doesn't repeat
// identically on every rebuild cycle.
let previousMarketFitAuditSignalIds = new Set<string>();

/** Optional DB sink — wired in Phase 2 to persist all evaluated rows. */
export type PregameBuildSink = (
  signals: PregamePowerSignal[],
  manifest: {
    buildId: string;
    sessionDate: string;
    startedAt: string;
    completedAt: string;
    gamesScanned: number;
    battersEvaluated: number;
    lineupCoverage: number;
    weatherCoverage: number;
    batterCoverage: number;
    pitcherCoverage: number;
    signalsCreated: number;
    suppressedCount: number;
  },
) => Promise<void>;

let buildSink: PregameBuildSink | null = null;
export function setPregameBuildSink(sink: PregameBuildSink): void {
  buildSink = sink;
}

/** Plain-English wind-direction label for the park-context display contract. */
function windDirectionLabel(dir: "in" | "out" | "cross" | "calm" | null): string | null {
  switch (dir) {
    case "out": return "Out";
    case "in": return "In";
    case "cross": return "Crosswind";
    case "calm": return "Calm";
    default: return null;
  }
}

export function mapGameStatus(espnStatus: string | undefined): PregameGameStatus {
  const s = (espnStatus ?? "").toUpperCase();
  if (s.includes("FINAL")) return "final";
  // Checked before the general IN_PROGRESS/LIVE match — a suspended game is
  // still technically "in progress" in some feeds, but it must resolve to its
  // own distinct status (paused, non-terminal; see gradedStateCarry.ts and
  // diagnostics.ts for how "suspended" is handled downstream) rather than
  // "live".
  if (s.includes("SUSPEND")) return "suspended";
  if (s.includes("IN_PROGRESS") || s.includes("LIVE")) return "live";
  if (s.includes("POSTPONED")) return "postponed";
  if (s.includes("DELAY")) return "delayed";
  if (s.includes("PRE")) return "pre";
  if (s.includes("SCHEDULED")) return "scheduled";
  return "unknown";
}

/**
 * Lower bound for the near-HR recent-form lookback query — 3 ET calendar
 * days before `sessionDateEt`, floored using the EDT (UTC-4) offset so the
 * cutoff always lands at or before the true local midnight regardless of
 * DST (EDT's UTC instant for local midnight is earlier than EST's for the
 * same date — using EDT's offset guarantees a safe over-fetch, never an
 * under-fetch). computeNearHrRecentForm exact-filters every row by ET
 * calendar day before use, so the extra slop is harmless.
 */
function nearHrLookbackSinceUtc(sessionDateEt: string): Date {
  const [y, m, d] = sessionDateEt.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 3, 4, 0, 0));
}

function savantToPowerInputs(s: Awaited<ReturnType<typeof fetchBaseballSavantData>>): BatterPowerInputs {
  return {
    xISO: s.xISOSeason,
    xSLG: s.xSLG,
    barrelRatePct: s.barrelRateProxySeason,
    hardHitRatePct: s.hardHitRateSeason,
    exitVelocity: s.exitVelocity,
    maxEV: s.maxEV,
    flyBallPct: s.flyBallPercent,
    hrFBRatioPct: s.hrFBRatio,
    pullRatePct: s.pullRatePercent,
    sweetSpotPct: s.sweetSpotPercent,
    xwOBA: s.xwOBASeason,
    battedBallEvents: s.battedBallEvents,
  };
}

/**
 * Run a full build. Returns the snapshot it stored (or the previous one if a
 * build is already running). Never throws.
 */
export async function buildPregamePowerRadar(): Promise<PregamePowerSnapshot | null> {
  if (isPregamePowerRadarBuildRunning) {
    console.log("[PREGAME_POWER_RADAR_BUILD_START] skipped — build already running");
    return null;
  }
  isPregamePowerRadarBuildRunning = true;
  const startedAt = new Date().toISOString();
  const buildId = `ppr_${Date.now()}_${randomUUID().slice(0, 8)}`;
  // Uses the same 6am-ET slate-day cutoff as discoverTodaysGames() below, so a
  // build that runs between midnight and 6am ET (which still discovers
  // yesterday's slate) tags the resulting signals with yesterday's date too —
  // instead of minting "today"-tagged wins for a slate that already finished.
  const sessionDate = slateDateET();
  // Read once per build so every candidate in a cycle is treated identically —
  // and so a mid-build env change can never split the slate across two regimes.
  const shadowEnabled = isPlateShadowChallengerEnabled();
  console.log(`[PREGAME_POWER_RADAR_BUILD_START] buildId=${buildId} date=${sessionDate} shadow=${shadowEnabled}`);
  let shadowEvaluated = 0;
  let shadowFailed = 0;
  let shadowDeltas = 0;
  let shadowTotalMs = 0;

  // Previous same-slate snapshot — source of already-stamped grading/bridge
  // state that must survive this rebuild (see carryForwardGradedState).
  const prevSnapshot = getSnapshot();
  const prevSignals =
    prevSnapshot && prevSnapshot.sessionDate === sessionDate ? prevSnapshot.signals : null;
  // Grouped by gameId so a batter dropped from the live lineup (see
  // carryForwardDroppedFromLineup below) can be found without an O(games ×
  // prevSignals) scan.
  const prevSignalsByGame = new Map<string, PregamePowerSignal[]>();
  if (prevSignals) {
    for (const s of Array.from(prevSignals.values())) {
      const list = prevSignalsByGame.get(s.gameId);
      if (list) list.push(s);
      else prevSignalsByGame.set(s.gameId, [s]);
    }
  }

  const signals = new Map<string, PregamePowerSignal>();
  // ISO assessment-boundary accumulator — one entry per assessIso() call (i.e.
  // every hitter for whom the ISO driver was emitted), captured here rather than
  // inferred from signals downstream.
  const isoAssessments: IsoAssessment[] = [];
  // Plate HR Probability V2 (PR 1) — research-only accumulators, populated
  // only when PLATE_HR_V2_FORWARD_CAPTURE_ENABLED is set (see
  // capturePlateHrV2Candidate/captureSufficientStatsIfNeeded below). Flushed
  // once at the end of the build, mirroring buildSink's own end-of-build
  // flush. Zero production/publication authority.
  const plateHrV2Captures: PlateHrV2CaptureRow[] = [];
  const plateHrV2SufficientStatsCaptures: PlateHrV2SufficientStatsCaptureRow[] = [];
  // Keyed "entityType:entityId", not entityId alone — a two-way player (e.g.
  // a starter who also DHs) shares one raw MLB id across both roles, and the
  // persisted stats id (plate-hr-v2-stats:${entityType}:${entityId}:${date})
  // already treats batter/pitcher as separate rows. An id-only Set would
  // silently drop whichever role's capture is encountered second, leaving
  // the other role's feature snapshot pointing at a sufficientStatsRef that
  // was never inserted.
  const plateHrV2SufficientStatsCaptured = new Set<string>();
  let gamesScanned = 0;
  let battersEvaluated = 0;
  let lineupGames = 0;
  let weatherGames = 0;
  let batterWithPower = 0;
  let pitcherResolved = 0;
  let createdPublicEligible = 0;
  let suppressedCount = 0;
  // Collected during the loop, emitted as ONE aggregated (and deduped-across-
  // rebuilds) log line after the build completes — see marketFitAudit's usage
  // below and the dedup block near [PREGAME_POWER_RADAR_BUILD_COMPLETE].
  const marketFitAuditFlags: Array<{ signalId: string; reason: string }> = [];

  try {
    const games = await discoverTodaysGames();

    // Defense-in-depth: discoverTodaysGames() now throws on a failed fetch
    // instead of returning [] (see gameDiscoveryService.ts), so this branch
    // should be unreachable in practice — but if some other/future path ever
    // returns a legitimately-empty-but-not-thrown result while today's board
    // already has real signals in memory, refuse to wipe it. A true off-day
    // (no prior signals to protect) still proceeds and builds an empty board.
    if (games.length === 0 && prevSignals && prevSignals.size > 0) {
      console.warn(
        `[PREGAME_POWER_RADAR_EMPTY_DISCOVERY] buildId=${buildId} date=${sessionDate} discovery returned 0 games with ${prevSignals.size} prior signals in memory — preserving existing snapshot`,
      );
      isPregamePowerRadarBuildRunning = false;
      return prevSnapshot;
    }

    for (const game of games) {
      gamesScanned++;
      const gameStatus = mapGameStatus(game.espnStatus);
      const startsAt = game.startTime || null;
      const firstPitchLockEligible = gameStatus === "scheduled" || gameStatus === "pre";

      // The roster + weather stores are keyed by the MLB Stats gamePk (the
      // statsapi feed/live id), NOT the ESPN event id in game.gameId. Without a
      // gamePk we cannot hydrate lineups/pitchers/weather — skip cleanly.
      const gamePk = game.gamePk ?? null;
      if (!gamePk) {
        console.log(`[PREGAME_POWER_RADAR_GAME_SCANNED] game=${game.gameId} skipped — no gamePk`);
        // A transient MLB Stats API failure can leave gamePk unresolved for a
        // cycle even after this game was already built (see fetchMlbGamePkMap).
        // Without this, the bare `continue` above ran before this game's
        // dropped-batter carry-forward — the only thing that preserves
        // already-graded HR winners across rebuilds — ever got a chance to
        // run, silently wiping the whole game's signals (winners included)
        // from the board for the rest of the day. Treat the whole game as
        // "every batter dropped from the lineup" so it reuses that same
        // preservation path.
        const carriedOver = carryForwardDroppedFromLineup(
          game.gameId,
          new Set(),
          prevSignalsByGame.get(game.gameId) ?? [],
          gameStatus,
          firstPitchLockEligible,
          new Date().toISOString(),
          buildId,
        );
        for (const carried of carriedOver) {
          signals.set(carried.signalId, carried);
          console.log(
            `[PREGAME_POWER_RADAR_SIGNAL_CARRIED] ${carried.signalId} ${carried.batterName} game gamePk unresolved this cycle — preserved (status=${carried.status})`,
          );
        }
        continue;
      }

      // Hydrate lineups, starters, and weather for this game (none are populated
      // elsewhere for pre-game slates). Independent fetches → run in parallel;
      // each is internally try/catch'd so one failure can't abort the build.
      // Weather is cached under the ESPN game.gameId (matching the orchestrator's
      // `syncWeather(gamePk, gameId)`) so the signal's gameId and the live
      // weather entry stay aligned; lineups/pitchers key by gamePk.
      try {
        await Promise.all([
          updateStartingLineups(gamePk),
          updateStartingPitchers(gamePk),
          // Open-Meteo is a forecast fallback for when MLB's own live feed
          // hasn't posted weather yet — exactly the common case for a
          // pregame build running hours before first pitch. Mirrors the
          // live in-game orchestrator's own syncWeather→syncOpenMeteoWeather
          // chaining pattern (liveGameOrchestrator.ts) so this radar gets the
          // same fallback instead of just taking the coverage hit.
          syncWeather(gamePk, game.gameId).then(async () => {
            const w = mlbGameCache.weather[game.gameId];
            if (w?.venueName) {
              await syncOpenMeteoWeather(game.gameId, w.venueName);
            }
          }),
        ]);
      } catch {
        /* hydration failures degrade to empty/neutral below */
      }

      const lineup = getStartingLineup(gamePk);
      const lineupPosted = lineup.length > 0;
      if (lineupPosted) lineupGames++;

      // Near-HR recent-form: one batch query per game (not per-player N+1).
      // Never touches the game currently being scored — sessionDate is the
      // leakage boundary, enforced again inside computeNearHrRecentForm.
      const nearHrContactByPlayer = new Map<string, RecentContactEventRow[]>();
      if (lineup.length > 0) {
        const rows = await fetchRecentContactEventsForBatters(
          lineup.map((l) => l.playerId),
          nearHrLookbackSinceUtc(sessionDate),
        );
        for (const r of rows) {
          if (!nearHrContactByPlayer.has(r.playerId)) nearHrContactByPlayer.set(r.playerId, []);
          nearHrContactByPlayer.get(r.playerId)!.push(r);
        }
      }

      const weather = mlbGameCache.weather[game.gameId];
      const venueName = weather?.venueName ?? null;
      const weatherAvailable = !!weather && (weather.temperature != null || weather.windSpeed != null);
      const isIndoors = weather?.isIndoors ?? isVenueIndoors(venueName);
      if (weatherAvailable || isIndoors) weatherGames++;

      // Starters are keyed `${gamePk}:home|away`. Resolve the opposing starter
      // per batter by team side (both lineup.team and pitcher.team come from the
      // same MLB feed, so the abbreviations match — no ESPN/MLB skew).
      const sideStarters = [
        getStartingPitcher(`${gamePk}:home`),
        getStartingPitcher(`${gamePk}:away`),
      ].filter((p): p is NonNullable<typeof p> => !!p);
      const lineupTeams = Array.from(new Set(lineup.map((l) => l.team)));

      console.log(
        `[PREGAME_POWER_RADAR_GAME_SCANNED] game=${game.gameId} pk=${gamePk} ${game.awayTeam}@${game.homeTeam} ` +
          `status=${gameStatus} lineup=${lineup.length} starters=${sideStarters.length} weather=${weatherAvailable}`,
      );

      // Pitcher-side contact-quality + recent-form data — fetched ONCE per
      // game per starter (not per batter; every batter facing the same
      // starter would otherwise repeat the same lookup). Both are additive/
      // optional: absence degrades pitcherVulnerability to its existing
      // neutral path, exactly as when pitcherSplits is unavailable.
      const pitcherContactByPitcher = new Map<string, ReturnType<typeof aggregateRawPitcherContactSnapshot>>();
      const pitcherRecentFormByPitcher = new Map<string, Awaited<ReturnType<typeof fetchPitcherRecentStarts>>>();
      // These two feeds are CHALLENGER-ONLY inputs — the champion scores on
      // handedness HR/9 + ERA alone. When shadow evaluation AND V2 forward
      // capture are both off we skip the work entirely (a real per-starter
      // network saving); when either is on, each gatherer stays individually
      // try/caught so a research failure degrades to null research fields and
      // can never block champion construction.
      //
      // Correction 1 (PR1 review): V2 capture must own its own data
      // dependencies rather than silently depending on the unrelated shadow
      // flag — two otherwise-identical days must not produce different
      // training rows because shadowEnabled happened to differ. Widening
      // this condition also warms fetchBaseballSavantData's cache for the
      // opposing starter, which the V2 capture tap below reads a second time
      // (cache hit, not a new fetch) to build the pitch-arsenal matchup.
      const gatherResearchInputs = shadowEnabled || isPlateHrV2ForwardCaptureEnabled();
      const researchFetchFailed = new Set<string>();
      for (const starter of gatherResearchInputs ? sideStarters : []) {
        try {
          // Same fetchBaseballSavantData call the batter side already makes,
          // but keyed by the PITCHER's own id (mirroring buildMlbMoundRadar.ts)
          // — the batter-keyed call above never returns real pitcher-side
          // fields since Savant resolves batter/pitcher CSVs by whatever id
          // it's given.
          const pitcherSavant = await fetchBaseballSavantData(starter.pitcherId, gamePk);
          pitcherContactByPitcher.set(
            starter.pitcherId,
            aggregateRawPitcherContactSnapshot(pitcherSavant.pitcherContactCsvSource, {
              // Only the 5 Statcast-derived fields (barrel/hard-hit/fly-ball/
              // xSLG/xwOBA allowed) are used below, and those depend solely on
              // `source` — hr9Allowed/bb9/ipVariance (the only fields these
              // inputs affect) are ignored here, so leaving them honestly
              // "unavailable" costs nothing.
              seasonStatsAvailable: false,
              inningsPitchedSeason: null,
              homeRunsAllowedSeason: null,
              bb9Season: null,
              recentStartsAvailable: false,
              ipVarianceLast3: null,
            }),
          );
        } catch {
          /* research-only — degrade to null, never block the champion */
          researchFetchFailed.add(starter.pitcherId);
        }
        try {
          pitcherRecentFormByPitcher.set(starter.pitcherId, await fetchPitcherRecentStarts(starter.pitcherId));
        } catch {
          /* research-only — degrade to null, never block the champion */
          researchFetchFailed.add(starter.pitcherId);
        }
      }

      // Tracks batters actually resolved+scored this cycle — deliberately NOT
      // just `lineup.map(l => l.playerId)`. A batter whose id isn't yet in the
      // (boot + 24h-cadence) roster pool must look "dropped" to the
      // end-of-game carryForwardDroppedFromLineup call below, not "still
      // present," so an earlier successful signal for them (e.g. built before
      // a later team-roster resync filtered them out) can still be rescued
      // instead of silently vanishing.
      const resolvedBatterIds = new Set<string>();

      for (const slot of lineup) {
        const player = getPlayer(slot.playerId);
        if (!player) {
          console.log(
            `[PREGAME_POWER_RADAR_PLAYER_UNRESOLVED] game=${game.gameId} pk=${gamePk} playerId=${slot.playerId} slot=${slot.battingOrderSlot} — not in roster pool, skipped this cycle`,
          );
          continue;
        }
        resolvedBatterIds.add(player.playerId);
        battersEvaluated++;

        const batterTeam = slot.team;
        const opponent =
          lineupTeams.find((t) => t !== batterTeam) ??
          (batterTeam === game.homeTeam ? game.awayTeam : game.homeTeam);

        // Opposing starter: the side whose team differs from the batter's.
        const opposingPitcher = sideStarters.find((p) => p.team !== batterTeam) ?? null;
        const pitcherKnown = !!opposingPitcher;
        if (pitcherKnown) pitcherResolved++;

        // ── Gather inputs (each guarded — degrade to neutral on failure) ──────
        let savant: Awaited<ReturnType<typeof fetchBaseballSavantData>> | null = null;
        try {
          const savantId = player.savantId ?? player.playerId;
          savant = await fetchBaseballSavantData(String(savantId), gamePk);
        } catch {
          savant = null;
        }

        let pitcherSplits = null;
        if (opposingPitcher) {
          try {
            pitcherSplits = await fetchPitcherHandednessSplits(opposingPitcher.pitcherId);
          } catch {
            pitcherSplits = null;
          }
        }

        let batterSplits = null;
        try {
          batterSplits = await fetchBatterHandednessSplits(player.playerId);
        } catch {
          batterSplits = null;
        }

        // BvP context — sync (network, guarded) so the cache is populated before
        // we read it below. Low/medium-confidence context only; never the model.
        if (opposingPitcher) {
          try {
            await syncBvPMatchup(player.playerId, opposingPitcher.pitcherId);
          } catch {
            /* BvP is optional context — ignore failures */
          }
        }

        // Batter's own production from today's lineup slot (real feed: per-game
        // stat lines aggregated by slot). Guarded; degrades to "unavailable".
        try {
          await syncBatterOrderSplits(player.playerId);
        } catch {
          /* lineup-slot split is optional context — ignore failures */
        }

        // Canonical TRUE per-PA ISO (SLG − AVG) for the DISPLAY tag only — the
        // matchup split matching the opposing pitcher's hand, from real season
        // split rate stats sharing one AB denominator. Never fed to the score.
        // Absent split / unknown pitcher hand → fails closed (no elite chip).
        const isoThrows = opposingPitcher?.throws;
        const isoSlg = isoThrows === "L" ? batterSplits?.slgVsLHP ?? null : isoThrows === "R" ? batterSplits?.slgVsRHP ?? null : null;
        const isoAvg = isoThrows === "L" ? batterSplits?.avgVsLHP ?? null : isoThrows === "R" ? batterSplits?.avgVsRHP ?? null : null;
        const isoAb = isoThrows === "L" ? batterSplits?.abVsLHP ?? null : isoThrows === "R" ? batterSplits?.abVsRHP ?? null : null;
        const trueIsoInputs: Pick<BatterPowerInputs, "trueIso" | "trueIsoSampleAB" | "trueIsoSplit" | "trueIsoSource"> =
          isoSlg != null && isoAvg != null
            ? {
                trueIso: isoSlg - isoAvg,
                trueIsoSampleAB: isoAb,
                trueIsoSplit: isoThrows === "L" ? "vs_lhp" : "vs_rhp",
                trueIsoSource: "current_split",
              }
            : { trueIso: null, trueIsoSampleAB: null, trueIsoSplit: "overall", trueIsoSource: "league_fallback" };

        // ── Compute components ────────────────────────────────────────────────
        const powerInputs: BatterPowerInputs = savant
          ? { ...savantToPowerInputs(savant), ...trueIsoInputs }
          : {
              xISO: null, xSLG: null, barrelRatePct: null, hardHitRatePct: null,
              exitVelocity: null, maxEV: null, flyBallPct: null, hrFBRatioPct: null,
              pullRatePct: null, sweetSpotPct: null, xwOBA: null, battedBallEvents: null,
              ...trueIsoInputs,
            };
        const batterPower = computeBatterPowerProfile(powerInputs, PLATE_CHAMPION_POLICY.batter);
        // Capture the assessment at the boundary (non-null iff assessIso ran).
        if (batterPower.isoAssessment) isoAssessments.push(batterPower.isoAssessment);
        // computeBatterPowerProfile's own hasCore check is satisfied by xSLG
        // alone, so a Savant fetch that degraded to the bare 2-of-11-input
        // MLB-API fallback (batterDataQuality !== "full") still reports
        // available:true off a genuinely thin read. The coverage/cap
        // mechanism this flag feeds is meant to catch exactly that thinness,
        // so it must not be fooled by it.
        const batterPowerFullyAvailable = batterPower.available && savant?.batterDataQuality === "full";

        const pitcherContact = opposingPitcher ? pitcherContactByPitcher.get(opposingPitcher.pitcherId) : undefined;
        const pitcherRecentForm = opposingPitcher ? pitcherRecentFormByPitcher.get(opposingPitcher.pitcherId) : undefined;
        const pitcherVuln = computePitcherVulnerability({
          pitcherKnown,
          batterHand: player.bats,
          pitcherThrows: opposingPitcher?.throws ?? null,
          hrPer9VsLHB: pitcherSplits?.hrPer9VsLHB ?? null,
          hrPer9VsRHB: pitcherSplits?.hrPer9VsRHB ?? null,
          eraVsLHB: pitcherSplits?.eraVsLHB ?? null,
          eraVsRHB: pitcherSplits?.eraVsRHB ?? null,
          barrelAllowedPct: pitcherContact?.barrelAllowedPct ?? null,
          hardHitAllowedPct: pitcherContact?.hardHitAllowedPct ?? null,
          flyBallAllowedPct: pitcherContact?.flyBallAllowedPct ?? null,
          last3StartERA: pitcherRecentForm?.last3StartERA ?? null,
          daysSinceLastStart: pitcherRecentForm?.daysSinceLastStart ?? null,
        }, PLATE_CHAMPION_POLICY.pitcher);

        const parkHrFactor = venueName
          ? getMarketParkFactor(venueName, "home_runs", player.bats)
          : null;
        const parkWeather = computeParkWeatherScore({
          parkHrFactor,
          isIndoors,
          weatherAvailable,
          temperature: weather?.temperature ?? null,
          windSpeed: weather?.windSpeed ?? null,
          windDirection: weather?.windDirection ?? null,
        });

        const opsVsHand =
          opposingPitcher?.throws === "L"
            ? batterSplits?.opsVsLHP ?? null
            : opposingPitcher?.throws === "R"
              ? batterSplits?.opsVsRHP ?? null
              : null;

        // Read BvP from cache only — never fabricate. Present only when a prior
        // syncBvPMatchup populated it. atBats is the PA proxy for sample gating.
        const bvp = opposingPitcher
          ? mlbPlayerCache.bvpMatchups[`${player.playerId}_vs_${opposingPitcher.pitcherId}`] ?? null
          : null;
        const matchupFit = computeMatchupFit({
          batterHand: player.bats,
          pitcherThrows: opposingPitcher?.throws ?? null,
          batterOpsVsHand: opsVsHand,
          batterXslgVsDominantFamily: null,
          pullRatePct: savant?.pullRatePercent ?? null,
          parkFavorsPull: (parkHrFactor ?? 1) > 1.05,
          bvpPlateAppearances: bvp?.atBats ?? null,
          bvpHr: bvp?.homeRuns ?? null,
          bvpHits: bvp?.hits ?? null,
          bvpAtBats: bvp?.atBats ?? null,
          bvpStrikeouts: bvp?.strikeouts ?? null,
          bvpOps: bvp?.ops ?? null,
          bvpAvg: bvp?.avg ?? null,
        });

        // ── Layer 1: pitcher ALLOWED-by-opposing-slot vulnerability ─────────────
        // Reads the provider cache (keyed pitcherId → slot). No producer is wired
        // yet, so this resolves to "unavailable" in production and contributes
        // nothing — it never fabricates pitcher-order confidence. The scorer +
        // gate + regression tests are in place for when a real feed is connected.
        const pitcherOrderRow =
          opposingPitcher && slot.battingOrderSlot != null
            ? mlbPlayerCache.pitcherOrderSplits[opposingPitcher.pitcherId]?.slots?.[slot.battingOrderSlot] ?? null
            : null;
        const pitcherOrderSplit = computePitcherOrderSplit({
          slot: slot.battingOrderSlot,
          ab: pitcherOrderRow?.ab ?? null,
          r: pitcherOrderRow?.r ?? null,
          h: pitcherOrderRow?.h ?? null,
          doubles: pitcherOrderRow?.doubles ?? null,
          triples: pitcherOrderRow?.triples ?? null,
          hr: pitcherOrderRow?.hr ?? null,
          rbi: pitcherOrderRow?.rbi ?? null,
          bb: pitcherOrderRow?.bb ?? null,
          hbp: pitcherOrderRow?.hbp ?? null,
          so: pitcherOrderRow?.so ?? null,
          sb: pitcherOrderRow?.sb ?? null,
          cs: pitcherOrderRow?.cs ?? null,
          avg: pitcherOrderRow?.avg ?? null,
          obp: pitcherOrderRow?.obp ?? null,
          slg: pitcherOrderRow?.slg ?? null,
          ops: pitcherOrderRow?.ops ?? null,
        });

        // Batter's own production from TODAY's lineup slot (real feed).
        const batterSlotRow = mlbPlayerCache.batterOrderSplits[player.playerId]?.splits?.find(
          (s) => s.slot === slot.battingOrderSlot,
        );
        const batterOrderSplit = computeBatterOrderSplit({
          slot: slot.battingOrderSlot,
          pa: batterSlotRow?.pa ?? null,
          slg: batterSlotRow?.slg ?? null,
          ops: batterSlotRow?.ops ?? null,
        });

        // Combined pitcher vulnerability = handedness + pitcher-allowed-by-slot
        // (weighted strongly when present). A suppressive slot pulls it down.
        const pitcherVulnerabilityScore = (() => {
          if (pitcherVuln.available && pitcherOrderSplit.available) {
            return round1Score((pitcherVuln.score10 * 2 + pitcherOrderSplit.score10 * 3) / 5);
          }
          if (pitcherOrderSplit.available) return pitcherOrderSplit.score10;
          return pitcherVuln.score10; // handedness (or neutral 5 when unavailable)
        })();
        const pitcherProfileAvailable = pitcherVuln.available || pitcherOrderSplit.available;

        const lineupOpp = computeLineupOpportunity({
          battingOrderSlot: slot.battingOrderSlot,
          teamImpliedRuns: null,
          obpAhead: null,
        });

        const nearHrRecentForm = computeNearHrRecentForm({
          events: nearHrContactByPlayer.get(player.playerId) ?? [],
          sessionDateEt: sessionDate,
        });

        const marketTags = computeMarketTags({
          batterPowerScore: batterPower.score10,
          pitcherVulnerabilityScore,
          parkWeatherScore: parkWeather.score10,
          hrFBRatioPct: savant?.hrFBRatio ?? null,
          xISO: savant?.xISOSeason ?? null,
          hardHitRatePct: savant?.hardHitRateSeason ?? null,
        });

        // Audit-only: flags when the server's own primaryMarket selection has a
        // LOWER fit than the secondary market (reachable via eliteHrShape in
        // marketTagger.ts). Never changes primaryMarket/marketSetups. Collected
        // here and emitted as ONE aggregated, deduped-across-rebuilds log line
        // after the full build completes (see marketFitAuditFlags below) — a
        // per-signal log on every rebuild would repeat identically for a
        // signal that stays flagged across many cycles.
        const marketFitAudit = auditPrimaryMarketFit(marketTags.marketSetups);
        if (marketFitAudit.flagged) {
          // signalId isn't constructed until later in this loop body — this
          // audit-only identifier mirrors its shape without depending on it.
          marketFitAuditFlags.push({ signalId: `mlb-pregame:${sessionDate}:${game.gameId}:${player.playerId}`, reason: marketFitAudit.reason ?? "" });
        }

        // ── Drivers union + positive count ────────────────────────────────────
        const drivers: PowerDriver[] = [
          ...batterPower.drivers,
          ...pitcherVuln.drivers,
          ...pitcherOrderSplit.drivers,
          ...batterOrderSplit.drivers,
          ...matchupFit.drivers,
          ...parkWeather.drivers,
          ...lineupOpp.drivers,
          ...nearHrRecentForm.drivers,
          ...marketTags.drivers,
        ];
        // Counted against the CHAMPION's enumerated July-20 driver universe.
        //
        // This deliberately does NOT rely on being frozen before
        // appendAttackEnvironmentDrivers runs further below. That ordering
        // happens to exclude the `atkenv_*` tags today, but reorder those two
        // statements and zero-weight research tags would silently start
        // satisfying the two-driver minimum. Explicit membership is the
        // contract; call ordering is not.
        const positiveDriverCount = countPositiveDrivers(
          drivers,
          driverKeysForUniverse(PLATE_CHAMPION_POLICY.drivers.universe),
        );

        // ── Attack Environment (pitcher × park/weather × matchup-fit interaction) ──
        // Computed BEFORE scoring (classifyTier needs the tier as an input) using
        // only already-computed component scores/drivers — never raw stats, so
        // pitcher/park/matchup evidence already feeding score10 via its own
        // weighted component is never counted a second time here.
        const attackEnvironment = computeAttackEnvironment({
          batterPowerScore: batterPower.score10,
          pitcherVulnerabilityScore,
          matchupFitScore: matchupFit.score10,
          parkDirection: getParkDirection(parkWeather.drivers), // parkWeather's own drivers only
          carryType: parkWeather.carryType,
          selectedMarketScore:
            marketTags.primaryMarket === "home_runs"
              ? marketTags.marketScores.home_runs ?? 0
              : marketTags.marketScores.total_bases ?? 0,
        });

        // "posted" = the official batting order has been posted for this game
        // (the only real signal available — MLB gives no separate confirmation
        // flag). Every batter reaching this loop is already in a posted lineup
        // by construction (the loop iterates `lineup`, which is only non-empty
        // once posted), so this is semantic cleanup replacing a hardcoded
        // literal with an honest derivation, not a new behavior.
        const lineupStatus: PregameLineupStatus = lineupPosted ? "posted" : "unposted";

        const scoring = composePregameScore(
          {
            batterPowerScore: batterPower.score10,
            pitcherVulnerabilityScore,
            matchupFitScore: matchupFit.score10,
            parkWeatherScore: parkWeather.score10,
            lineupOpportunityScore: lineupOpp.score10,
            nearHrRecentFormScore: nearHrRecentForm.score10,
            bvpModifier: matchupFit.bvpModifier,
          },
          {
            // CHAMPION (July-20) availability: the component's own
            // `available` flag. The stricter savant-quality read is still
            // computed and recorded under diagnostics.dataQuality, but it is a
            // measurement, not a champion gate — see §10 of the plan.
            batterPowerAvailable: batterPower.available,
            pitcherProfileAvailable,
            confirmedLineup: lineupStatus === "posted",
            // CHAMPION (July-20) availability: `parkHrFactor != null`.
            // getMarketParkFactor always returns a number (1.0 fallback for
            // both "no venue" and "unmatched venue"), so this is true whenever
            // a venue name string exists at all, matched park or not. The
            // honest `isVenueResolved` read is preserved verbatim under
            // diagnostics.dataQuality.venueResolved and is a challenger input.
            parkAvailable: parkHrFactor != null,
            weatherAvailable,
            bvpAvailable: matchupFit.bvpAvailable,
            parkIsOnlyPositiveDriver: parkWeather.parkIsOnlyPositiveDriver,
            positiveDriverCount,
            bvpDirection: matchupFit.bvpDirection,
            bvpZeroProduction: matchupFit.bvpZeroProduction,
            pitcherOrderSplitDirection: pitcherOrderSplit.direction,
            batterOrderSplitDirection: batterOrderSplit.direction,
            attackEnvironmentTier: attackEnvironment.tier,
            // Pass the ALREADY-COMPUTED eliminationEligible boolean through
            // verbatim — scoring.ts must never re-derive the independently-elite
            // threshold itself; computeAttackEnvironment() is the one and only
            // place that threshold is applied.
            attackEnvironmentEliminationEligible: attackEnvironment.eliminationEligible,
          },
          // Explicit — production model selection never rides on a default.
          PLATE_CHAMPION_POLICY.gates,
        );
        if (batterPower.available) batterWithPower++;

        // Compact-card "Grade Factors" — display-only summary of the terms
        // composePregameScore already computed above. Never re-derives score10/
        // tier/qualification; see gradeFactorSummary.ts for the realized-impact
        // math and the "never fabricate Pitcher Vulnerability" null guard.
        const gradeFactorSummary = buildGradeFactorSummary({
          components: [
            { key: "batterPower", label: "Batter Power", score: batterPower.score10, available: batterPower.available },
            { key: "pitcherVulnerability", label: "Pitcher Vulnerability", score: pitcherVulnerabilityScore, available: pitcherProfileAvailable },
            { key: "matchupFit", label: "Matchup Fit", score: matchupFit.score10, available: matchupFit.available },
            { key: "parkWeather", label: "Park & Weather", score: parkWeather.score10, available: parkWeather.available },
            { key: "lineupOpportunity", label: "Lineup Opportunity", score: lineupOpp.score10, available: lineupOpp.available },
            { key: "nearHrRecentForm", label: "Near-HR Recent Form", score: nearHrRecentForm.score10, available: nearHrRecentForm.available },
          ],
          bvpModifier: matchupFit.bvpModifier,
          bvpAvailable: matchupFit.bvpAvailable,
          baseScore: scoring.baseScore,
          finalScoreBeforeCaps: scoring.finalScoreBeforeCaps,
          finalScoreCap: scoring.finalScoreCap,
          matchupPenalty: scoring.matchupPenalty,
          score10: scoring.score10,
        });

        // Surface any matchup downgrade tags that aren't already a driver label as
        // negative drivers so the UI renders them as warning chips (dedup avoids
        // double chips like "Pitcher Slot Suppression" from both scorer + tag).
        const existingLabels = new Set(drivers.map((d) => d.label));
        for (const tag of scoring.warningTags) {
          if (existingLabels.has(tag)) continue;
          drivers.push({ key: `warn_${tag.replace(/\s+/g, "_").toLowerCase()}`, label: tag, direction: "negative", weight: 0 });
        }

        // Attack Environment tags — appended STRICTLY AFTER scoring/positiveDriverCount
        // above, and only emitted when the gate actually changed the outcome (see
        // appendAttackEnvironmentDrivers). Never affects positiveDriverCount or
        // insufficient_drivers, since positiveDriverCount was already frozen.
        appendAttackEnvironmentDrivers(drivers, attackEnvironment, scoring, marketTags.primaryMarket);

        const warnings = [
          ...batterPower.warnings,
          ...pitcherVuln.warnings,
          ...matchupFit.warnings,
          ...parkWeather.warnings,
          ...lineupOpp.warnings,
          ...nearHrRecentForm.warnings,
        ];

        const weatherStatus: PregameWeatherStatus = isIndoors
          ? "roof"
          : weatherAvailable
            ? "estimated"
            : "unknown";

        // Server-owned park/weather display contract. Carry label/type come
        // straight from the scorer (display-only — never re-derived on the client).
        const parkContext: PregameParkContext = {
          venueName,
          temperatureF: isIndoors ? null : weather?.temperature ?? null,
          windMph: isIndoors ? null : weather?.windSpeed ?? null,
          windDirectionLabel: isIndoors ? null : windDirectionLabel(weather?.windDirection ?? null),
          carryLabel: parkWeather.carryLabel,
          carryType: parkWeather.carryType,
          driverText: parkWeather.carryDriverText,
        };

        // Player-specific park/wind fit — DISPLAY/EXPLAINABILITY ONLY (PR2).
        // Hydrated from the shared parkWindFit module using the batter's hand +
        // pull profile + the game's wind sector. It is computed AFTER scoring and
        // is NEVER fed into score10 or any scoring component. Neutral/❔ fallback
        // when venue, handedness, or wind data is missing.
        // Indoor / closed-roof games hide wind entirely (matching the park row).
        // Clear ALL wind sources so the fit can't render a stale "Out to LF 5 mph"
        // beside the "Roof closed · neutral carry" label.
        const playerParkWindFit = hydratePregamePlayerParkWindFit({
          venueName,
          batterHand: player.bats,
          pullRatePercent: savant?.pullRatePercent ?? null,
          windString: isIndoors ? null : weather?.windString ?? null,
          windDegrees: isIndoors ? null : weather?.windDegrees ?? null,
          windDirectionCoarse: isIndoors ? null : weather?.windDirection ?? null,
          windSpeedMph: isIndoors ? null : weather?.windSpeed ?? null,
          isIndoors,
        });

        const signalId = `mlb-pregame:${sessionDate}:${game.gameId}:${player.playerId}`;
        const generatedAt = new Date().toISOString();
        // A suspended game has already started — suspension itself is
        // sufficient to force the lock, independent of firstPitchLockEligible
        // (which is derived from gameStatus at the top of this game's loop
        // iteration and is not re-verified for consistency here).
        const isLocked =
          gameStatus === "suspended" ||
          (!firstPitchLockEligible && (gameStatus === "live" || gameStatus === "final"));

        const signal: PregamePowerSignal = {
          signalId,
          sport: "mlb",
          engine: "pregame_power_radar",
          sessionDate,
          gameId: game.gameId,
          gameDate: sessionDate,
          startsAt,
          generatedAt,
          buildId,
          batterId: player.playerId,
          batterName: player.playerName,
          team: batterTeam,
          opponent,
          pitcherId: opposingPitcher?.pitcherId ?? null,
          pitcherName: opposingPitcher?.pitcherName ?? null,
          battingOrderSlot: slot.battingOrderSlot,
          handednessMatchup: opposingPitcher
            ? `${player.bats} vs ${opposingPitcher.throws ?? "?"}`
            : null,
          primaryMarket: marketTags.primaryMarket,
          marketTags: marketTags.marketTags,
          marketScores: marketTags.marketScores,
          marketSetups: marketTags.marketSetups,
          parkContext,
          playerParkWindFit,
          score10: scoring.score10,
          tier: scoring.tier,
          drivers,
          warnings,
          tags: scoring.warningTags,
          lineupStatus,
          weatherStatus,
          gameStatus,
          firstPitchLockEligible,
          lockedAt: isLocked ? generatedAt : null,
          hasMarketLine: false,
          isOfficialPlay: false,
          isPregameTarget: true,
          // `isLocked` already covers live/final games (see above), so by the
          // time we reach the else branch `gameStatus` can only be a non-final
          // pre-game/limbo state (scheduled/pre/postponed/delayed/unknown) →
          // "active". A separate `gameStatus === "final" ? "expired"` check here
          // was dead code (final games are always "locked" first) and tripped
          // TS2367. Final → "graded" is owned by the shadow grader, not here.
          status: isLocked ? "locked" : "active",
          suppressed: scoring.suppressed,
          suppressedReasons: scoring.suppressedReasons,
          outcomes: null,
          everPubliclyFlagged: false,
          // Initial value for THIS build only — carryForwardGradedState OR's it
          // forward against the previous same-slate copy so a later rebuild
          // whose live-refetched inputs no longer trigger the reason can never
          // erase an earlier true evaluation (same discipline as
          // everPubliclyFlagged above).
          everAttackEnvironmentSuppressed: scoring.suppressedReasons.includes(ATTACK_ENVIRONMENT_HOSTILE_SUPPRESSION_REASON),
          attackEnvironmentSuppressedScore10: scoring.suppressedReasons.includes(ATTACK_ENVIRONMENT_HOSTILE_SUPPRESSION_REASON)
            ? scoring.score10
            : null,
          becameLiveReady: false,
          becameLiveFire: false,
          convertedLiveAt: null,
          diagnostics: {
            batterPowerScore: batterPower.available ? batterPower.score10 : null,
            pitcherVulnerabilityScore: pitcherProfileAvailable ? pitcherVulnerabilityScore : null,
            pitcherHandednessScore: pitcherVuln.available ? pitcherVuln.score10 : null,
            matchupFitScore: matchupFit.available ? matchupFit.score10 : null,
            parkWeatherScore: parkWeather.available ? parkWeather.score10 : null,
            lineupOpportunityScore: lineupOpp.available ? lineupOpp.score10 : null,
            marketFitScore: marketTags.score10,
            nearHrRecentFormScore: nearHrRecentForm.available ? nearHrRecentForm.score10 : null,
            attackEnvironmentTier: attackEnvironment.tier,
            attackEnvironmentDirection: attackEnvironment.direction,
            attackEnvironmentCohort: attackEnvironment.cohort,
            attackEnvironmentEliminationEligible: attackEnvironment.eliminationEligible,
            pitcherOrderSplitAvailable: pitcherOrderSplit.available,
            pitcherOrderSplitScore: pitcherOrderSplit.available ? pitcherOrderSplit.score10 : null,
            pitcherOrderSplitDirection: pitcherOrderSplit.direction,
            batterCurrentOrderSlot: slot.battingOrderSlot,
            batterOrderSplitAvailable: batterOrderSplit.available,
            batterOrderSplitScore: batterOrderSplit.available ? batterOrderSplit.score10 : null,
            batterOrderSplitDirection: batterOrderSplit.direction,
            bvpAvailable: matchupFit.bvpAvailable,
            bvpScore: matchupFit.bvpScore,
            bvpSampleSize: matchupFit.bvpAvailable ? matchupFit.bvpSampleSize : null,
            bvpHits: matchupFit.bvpAvailable ? matchupFit.bvpHits : null,
            bvpDirection: matchupFit.bvpDirection,
            zeroProductionBvpFlags: matchupFit.zeroProductionFlags,
            dataCoverageScore: scoring.dataCoverageScore,
            finalScoreCap: scoring.finalScoreCap,
            finalScoreBeforeCaps: scoring.finalScoreBeforeCaps,
            finalScoreAfterCaps: scoring.score10,
            matchupPenalty: scoring.matchupPenalty,
            publicTier: scoring.tier,
            warningTags: scoring.warningTags,
            downgradeReasons: scoring.downgradeReasons,
            suppressed: scoring.suppressed,
            suppressedReasons: scoring.suppressedReasons,
            sourceFreshness: {
              weatherUpdatedAt: weather?.fetchedAt ? new Date(weather.fetchedAt).toISOString() : null,
            },
            // CHAMPION availability semantics — diagnostics.ts re-reads these
            // as publication inputs, so they must agree with the flags passed
            // to composePregameScore above. The honest/strict reads live
            // alongside under `dataQuality`.
            rawInputsAvailable: {
              lineup: lineupStatus === "posted",
              batterPower: batterPower.available,
              pitcherProfile: pitcherProfileAvailable,
              park: parkHrFactor != null,
              weather: weatherAvailable,
              bvp: matchupFit.bvpAvailable,
              nearHrRecentForm: nearHrRecentForm.available,
            },
            // Honest data-quality measurement, kept strictly SEPARATE from
            // champion model semantics (§10). Recorded for diagnostics and as a
            // challenger input; it never gates the champion.
            dataQuality: {
              savantQuality: savant
                ? savant.batterDataQuality === "full"
                  ? "full"
                  : "fallback"
                : "missing",
              venueResolved: isVenueResolved(venueName),
              pitcherHandResolved: opposingPitcher?.throws != null,
              batterPowerFullyAvailable,
            },
            // Display-only snapshot of the raw hitter inputs already computed
            // above — no re-fetch, no recompute, never fed back into scoring.
            // gradedStateCarry freezes this to the original pregame values.
            powerProfile: {
              xISO: powerInputs.xISO,
              hrFBRatioPct: powerInputs.hrFBRatioPct,
              barrelRatePct: powerInputs.barrelRatePct,
              hardHitRatePct: powerInputs.hardHitRatePct,
              maxEV: powerInputs.maxEV,
              pullRatePct: powerInputs.pullRatePct,
            },
            gradeFactorSummary,
          },
        };

        carryForwardGradedState(signal, prevSignals?.get(signalId));

        // ── Shadow challenger ────────────────────────────────────────────────
        // Runs ONLY here: the champion signal above is fully assembled and
        // carried forward, so nothing below can alter it. Persistence happens
        // once, at the end of the build via buildSink — attaching the comparison
        // here means the champion and its shadow record land in the same write.
        //
        // Fail-open by construction: any throw is logged and dropped, the signal
        // keeps `challengerUnavailable`, and the build continues.
        {
          const frozen = freezePlateInput({
            sessionDate,
            gameId: game.gameId,
            batterId: player.playerId,
            pitcherId: opposingPitcher?.pitcherId ?? null,
            batter: {
              xISO: powerInputs.xISO, xSLG: powerInputs.xSLG,
              barrelRatePct: powerInputs.barrelRatePct, hardHitRatePct: powerInputs.hardHitRatePct,
              exitVelocity: powerInputs.exitVelocity, maxEV: powerInputs.maxEV,
              flyBallPct: powerInputs.flyBallPct, hrFBRatioPct: powerInputs.hrFBRatioPct,
              pullRatePct: powerInputs.pullRatePct, sweetSpotPct: powerInputs.sweetSpotPct,
              xwOBA: powerInputs.xwOBA, battedBallEvents: powerInputs.battedBallEvents,
              bats: player.bats,
            },
            pitcher: {
              pitcherKnown,
              throws: opposingPitcher?.throws ?? null,
              hrPer9VsLHB: pitcherSplits?.hrPer9VsLHB ?? null,
              hrPer9VsRHB: pitcherSplits?.hrPer9VsRHB ?? null,
              eraVsLHB: pitcherSplits?.eraVsLHB ?? null,
              eraVsRHB: pitcherSplits?.eraVsRHB ?? null,
            },
            research: !shadowEnabled
              ? RESEARCH_UNCOLLECTED
              : !opposingPitcher
                ? { ...RESEARCH_UNCOLLECTED, unavailableReason: "no_pitcher" as const }
                : {
                    collected: !researchFetchFailed.has(opposingPitcher.pitcherId),
                    unavailableReason: researchFetchFailed.has(opposingPitcher.pitcherId)
                      ? ("fetch_failed" as const)
                      : null,
                    barrelAllowedPct: pitcherContact?.barrelAllowedPct ?? null,
                    hardHitAllowedPct: pitcherContact?.hardHitAllowedPct ?? null,
                    flyBallAllowedPct: pitcherContact?.flyBallAllowedPct ?? null,
                    last3StartERA: pitcherRecentForm?.last3StartERA ?? null,
                    daysSinceLastStart: pitcherRecentForm?.daysSinceLastStart ?? null,
                  },
            matchup: {
              batterOpsVsHand: opsVsHand,
              batterXslgVsDominantFamily: null,
              parkFavorsPull: (parkHrFactor ?? 1) > 1.05,
              bvpPlateAppearances: bvp?.atBats ?? null,
              bvpAtBats: bvp?.atBats ?? null,
              bvpHr: bvp?.homeRuns ?? null,
              bvpHits: bvp?.hits ?? null,
              bvpStrikeouts: bvp?.strikeouts ?? null,
              bvpOps: bvp?.ops ?? null,
              bvpAvg: bvp?.avg ?? null,
            },
            parkWeather: {
              parkHrFactor,
              isIndoors,
              weatherAvailable,
              temperature: weather?.temperature ?? null,
              windSpeed: weather?.windSpeed ?? null,
              windDirection: weather?.windDirection ?? null,
            },
            lineup: {
              battingOrderSlot: slot.battingOrderSlot,
              lineupPosted: lineupStatus === "posted",
              teamImpliedRuns: null,
              obpAhead: null,
            },
            // Policy-independent component OUTPUTS, frozen rather than
            // re-derived — this is what makes the shadow champion reproduce the
            // production champion exactly instead of approximating it.
            precomputed: {
              nearHrRecentForm: {
                score10: nearHrRecentForm.score10,
                available: nearHrRecentForm.available,
                drivers: nearHrRecentForm.drivers.slice(),
              },
              batterOrderSplit: {
                score10: batterOrderSplit.score10,
                direction: batterOrderSplit.direction,
                drivers: batterOrderSplit.drivers.slice(),
              },
              pitcherOrderSplit: {
                score10: pitcherOrderSplit.score10,
                available: pitcherOrderSplit.available,
                direction: pitcherOrderSplit.direction,
                drivers: pitcherOrderSplit.drivers.slice(),
              },
            },
            dataQuality: {
              savantQuality: savant ? (savant.batterDataQuality === "full" ? "full" : "fallback") : "missing",
              venueResolved: isVenueResolved(venueName),
              pitcherHandResolved: opposingPitcher?.throws != null,
            },
          });
          const frozenInputHash = hashFrozenPlateInput(frozen);
          const pubCtx = {
            lineupStatus,
            isOfficialPlay: signal.isOfficialPlay,
            isPregameTarget: signal.isPregameTarget,
          };

          let modelComparison: PlateModelComparisonRecord | null = shadowEnabled
            ? { championVersion: PLATE_CHAMPION_POLICY.version, challengerVersion: PLATE_CHALLENGER_POLICY.version, frozenInputHash, challengerUnavailable: "failed" as const }
            : { championVersion: PLATE_CHAMPION_POLICY.version, challengerVersion: PLATE_CHALLENGER_POLICY.version, frozenInputHash, challengerUnavailable: "disabled" as const };
          let shadowEvaluationMs: number | null = null;

          if (shadowEnabled) {
            const t0 = Date.now();
            try {
              // Both models receive the SAME frozen object — not two builds of
              // an equivalent one — so the recorded hash is a real proof.
              const championEval = evaluatePlateModel(frozen, PLATE_CHAMPION_POLICY, pubCtx);
              // Parity guard. The comparison is only meaningful if the shadow
              // champion IS the production champion — otherwise a delta could
              // come from the re-derivation rather than from policy. Log-only:
              // a mismatch must never alter the production signal.
              if (
                championEval.score10 !== scoring.score10 ||
                championEval.tier !== scoring.tier ||
                championEval.suppressed !== scoring.suppressed
              ) {
                console.warn(
                  `[PLATE_CHAMPION_PARITY_MISMATCH] ${signalId} ` +
                  `prod=${scoring.tier}/${scoring.score10}/${scoring.suppressed} ` +
                  `shadow=${championEval.tier}/${championEval.score10}/${championEval.suppressed}`,
                );
              }
              const challengerEval = evaluatePlateModel(frozen, PLATE_CHALLENGER_POLICY, pubCtx);
              const prevComparison = prevSignals?.get(signalId)?.diagnostics?.modelComparison ?? null;
              const comparison = buildPlateModelComparison(
                championEval, challengerEval, frozenInputHash, prevComparison, generatedAt,
              );
              modelComparison = comparison;
              shadowEvaluated++;
              if (shouldLogPlateDelta(comparison)) {
                shadowDeltas++;
                console.log(
                  `[PLATE_MODEL_DELTA] ${signalId} champ=${comparison.champion.tier}/${comparison.champion.score10}/${comparison.champion.publicEligible ? "public" : "hidden"} ` +
                  `chal=${comparison.challenger.tier}/${comparison.challenger.score10}/${comparison.challenger.publicEligible ? "public" : "hidden"} ` +
                  `market=${comparison.champion.primaryMarket}->${comparison.challenger.primaryMarket} ` +
                  `attribution=${comparison.attribution.join(",") || "none"}`,
                );
              }
            } catch (err: any) {
              shadowFailed++;
              console.warn(`[PLATE_SHADOW_FAILED] ${signalId} ${err?.message ?? err}`);
            }
            shadowEvaluationMs = Date.now() - t0;
            shadowTotalMs += shadowEvaluationMs;
          }

          signal.diagnostics.modelComparison = modelComparison;
          signal.diagnostics.shadowEvaluationMs = shadowEvaluationMs;
        }

        // ── V2 HR Probability forward feature capture (research-only, PR1,
        // default OFF) ──────────────────────────────────────────────────────
        // Strictly additive: reads only already-computed locals from this
        // loop iteration; never touches `signal`/`scoring`/`drivers`/
        // `suppressedReasons`. try/catch mirrors the shadow-challenger block
        // above and CLAUDE.md §3.6 / Hard Rule 8's analytics-tap discipline —
        // a failure here can never affect the champion signal or block the
        // build.
        if (isPlateHrV2ForwardCaptureEnabled()) {
          try {
            // Cache hit, not a new fetch, whenever gatherResearchInputs ran
            // for this game (guaranteed when V2 capture is on — see
            // correction 1 above): fetchBaseballSavantData caches by player
            // id regardless of gamePk.
            const pitcherSavantForMatchup = opposingPitcher
              ? await fetchBaseballSavantData(opposingPitcher.pitcherId, gamePk)
              : null;

            const hrPer9VsHand =
              player.bats === "L"
                ? pitcherSplits?.hrPer9VsLHB ?? null
                : player.bats === "R"
                  ? pitcherSplits?.hrPer9VsRHB ?? null
                  : null; // switch hitters: never guess, matches rosterService.ts's own "never guess" discipline

            const parkHrFactorGeneric = venueName ? getMarketParkFactor(venueName, "home_runs") : null;
            const pullSideGeometry = getPullSideParkGeometry(venueName, player.bats, opposingPitcher?.throws ?? null);

            const capturedAtMs = Date.parse(generatedAt);
            const firstPitchAtMs = startsAt ? Date.parse(startsAt) : null;
            // No real "lineup confirmed at" timestamp is tracked anywhere in
            // this build — approximated as "this build's time, if posted,"
            // never as a fabricated earlier moment.
            const lineupConfirmedAtMs = lineupStatus === "posted" ? capturedAtMs : null;

            const sufficientStatsRef = savant?.plateHrV2BatterSufficientStats
              ? plateHrV2SufficientStatsId("batter", player.playerId, sessionDate)
              : null;

            // PR3.1: assemble REAL per-provider/entity evidence descriptors from
            // the data this cycle actually fetched. A source with no real payload
            // is simply omitted (fail-closed) — nothing is synthesized. Game-level
            // evidence (pitcher/weather/park/lineup) carries batter-independent
            // content so it dedupes across the game's batters.
            const plateHrV2Evidence = assemblePlateHrV2EvidenceDescriptors({
              gamePk: String(gamePk),
              batterId: player.playerId,
              pitcherId: opposingPitcher?.pitcherId ?? null,
              capturedAtIso: new Date(capturedAtMs).toISOString(),
              firstPitchIso: startsAt ?? null,
              schemaVersion: PLATE_HR_V2_FEATURES_CURRENT,
              batterSufficientStats: savant?.plateHrV2BatterSufficientStats ?? null,
              batterStatsRef: sufficientStatsRef,
              batterFetchedAtMs: savant?.savantFetchedAtMs ?? null,
              batterDataThroughDate: savant?.savantDataThroughDate ?? null,
              pitcherSufficientStats: pitcherSavantForMatchup?.plateHrV2PitcherSufficientStats ?? null,
              pitcherStatsRef: opposingPitcher?.pitcherId
                ? plateHrV2SufficientStatsId("pitcher", opposingPitcher.pitcherId, sessionDate)
                : null,
              pitcherFetchedAtMs: pitcherSavantForMatchup?.savantFetchedAtMs ?? null,
              pitcherDataThroughDate: pitcherSavantForMatchup?.savantDataThroughDate ?? null,
              weather: {
                available: weatherAvailable,
                temperatureF: weather?.temperature ?? null,
                windSpeedMph: weather?.windSpeed ?? null,
                windDirection: weather?.windDirection ?? null,
                isIndoors,
              },
              lineupPosted: lineupStatus === "posted",
              park: {
                venueResolved: isVenueResolved(venueName),
                payload: { parkHrFactorGeneric, parkHrFactorHand: parkHrFactor, isIndoors, venueName },
              },
            });

            // PR5: stabilized recent-contact-form shadow feature from the batched
            // contact_events window + a season baseline, with a content-addressed
            // contact_events evidence descriptor for EXACT re-derivation. Shadow-only:
            // no scorer reads it; the boundary is the prediction moment (capture).
            const recentFormBuilt = buildRecentContactFormEvidence({
              events: nearHrContactByPlayer.get(player.playerId) ?? [],
              asOfExclusiveMs: capturedAtMs,
              retrievalAtMs: capturedAtMs,
              batterId: player.playerId,
              schemaVersion: PLATE_HR_V2_FEATURES_CURRENT,
              seasonBaseline: {
                avgEv: powerInputs.exitVelocity,
                ev90: savant?.plateHrV2BatterSufficientStats?.evPercentiles?.p90 ?? null,
                barrelPct: powerInputs.barrelRatePct,
                // No clean season air%(LA≥10) source — flyBall% is a stricter, different
                // definition, so it is deliberately left null (recent air% stays null).
                airBallPct: null,
                // pulled-air is intentionally NOT sourced: season pull-rate is a
                // mislabeled proxy (not air-specific), so recentFormPulledAirShare
                // stays null until a genuine pulled-air aggregate exists (PR5.2 gap 4).
              },
            });
            if (recentFormBuilt.evidence) plateHrV2Evidence.push(recentFormBuilt.evidence);

            const capturedRow = capturePlateHrV2Candidate({
              sessionDate,
              gameId: game.gameId,
              gamePk: String(gamePk),
              evidence: plateHrV2Evidence,
              recentContactForm: recentFormBuilt.inputs,
              buildId,
              batterId: player.playerId,
              batterName: player.playerName,
              team: batterTeam,
              opponent,
              pitcherId: opposingPitcher?.pitcherId ?? null,
              pitcherName: opposingPitcher?.pitcherName ?? null,
              battingOrderSlot: slot.battingOrderSlot,
              batterHand: player.bats,
              capturedAtMs,
              firstPitchAtMs,
              firstPitchLockEligible,
              gameStatus,
              lineupConfirmedAtMs,
              starterConfirmed: !!opposingPitcher,
              sufficientStatsRef,
              batterPower: {
                xISO: powerInputs.xISO,
                xSLG: powerInputs.xSLG,
                xwOBAcon: powerInputs.xwOBA, // best-available proxy — no distinct contact-only wOBA field exists yet
                barrelRatePct: powerInputs.barrelRatePct,
                hardHitRatePct: powerInputs.hardHitRatePct,
                exitVelocity: powerInputs.exitVelocity,
                maxEV: powerInputs.maxEV,
                flyBallPct: powerInputs.flyBallPct,
                hrFBRatioPct: powerInputs.hrFBRatioPct,
                pullRatePct: powerInputs.pullRatePct,
                sweetSpotPct: powerInputs.sweetSpotPct,
                hrPerPaSeason: null, // not computed anywhere in this build — honestly null, not fabricated
                paSample: powerInputs.battedBallEvents, // BBE as the available sample-size proxy
              },
              batTracking: {
                avgBatSpeed: savant?.avgBatSpeed ?? null,
                fastSwingRatePct: null,
                avgSwingLength: savant?.avgSwingLength ?? null,
                avgAttackAngle: null,
                idealAttackAngleRatePct: null,
                attackAngleStdDev: null,
                avgSwingPathTilt: null,
                squaredUpPerSwingPct: null,
                blastPerSwingPct: null,
                swingSample: null,
              },
              pitcherVulnerability: {
                pitcherKnown,
                batterHand: player.bats,
                pitcherThrows: opposingPitcher?.throws ?? null,
                hrPer9VsHand,
                hrPer9Overall: null,
                barrelAllowedPct: pitcherContact?.barrelAllowedPct ?? null,
                hardHitAllowedPct: pitcherContact?.hardHitAllowedPct ?? null,
                flyBallAllowedPct: pitcherContact?.flyBallAllowedPct ?? null,
                bfSample: null,
              },
              pitchType: buildPitchTypeInteractionInputsFromSavant(savant, pitcherSavantForMatchup),
              zoneLocation: {
                batterHeartXslg: null,
                batterElevatedFbXslg: null,
                batterLowBreakingXslg: null,
                pitcherHeartRate: null,
                pitcherMiddleMiddleRate: null,
                pitcherHangerRate: null,
              },
              parkWeatherSpray: {
                parkHrFactor: parkHrFactorGeneric,
                parkHrFactorHand: parkHrFactor,
                isIndoors,
                weatherAvailable,
                temperatureF: weather?.temperature ?? null,
                windSpeedMph: weather?.windSpeed ?? null,
                windDirection: weather?.windDirection ?? null,
                batterPullAirShare: savant?.pullRatePercent ?? null, // proxy — pull rate, not air-ball-specific pull share
                pullFenceDistanceFt: pullSideGeometry?.pullFenceDistanceFt ?? null,
                pullFenceHeightFt: pullSideGeometry?.pullFenceHeightFt ?? null,
                avgFenceDistanceFt: pullSideGeometry?.avgFenceDistanceFt ?? null,
                avgFenceHeightFt: pullSideGeometry?.avgFenceHeightFt ?? null,
                avgHrDistanceFt: pullSideGeometry?.avgHrDistanceFt ?? null,
              },
              lineupOpportunity: {
                battingOrderSlot: slot.battingOrderSlot,
                teamImpliedRuns: null,
                obpAhead: null,
                lineupConfirmed: lineupStatus === "posted",
              },
              starterBullpen: {
                starterConfirmed: !!opposingPitcher,
                projectedPaVsStarter: null,
                projectedPaVsBullpen: null,
                bullpenHrPer9: null,
                bullpenBarrelAllowedPct: null,
              },
              market: {
                hrOddsAvailable: false,
                impliedHrProbability: null,
                noVigImpliedHrProbability: null,
              },
              availability: {
                confirmedActive: lineupStatus === "posted",
                lateScratchRisk: null,
                restDayRisk: null,
                platoonSubRisk: null,
              },
              contactOpportunity: {
                kRatePct: null,
                bbRatePct: null,
                whiffRatePct: null,
                contactRatePct: null,
                zoneContactRatePct: null,
                chaseRatePct: null,
              },
              slateBaselineGameHrProbability: null,
              savantQuality: savant ? (savant.batterDataQuality === "full" ? "full" : "fallback") : "missing",
              venueResolved: isVenueResolved(venueName),
              pitcherHandResolved: opposingPitcher?.throws != null,
              batterPowerFullyAvailable,
              championModelVersion: PLATE_CHAMPION_POLICY.version,
              championScore10: scoring.score10,
              championTier: scoring.tier,
              championSuppressed: scoring.suppressed,
            });
            if (capturedRow) plateHrV2Captures.push(capturedRow);

            const batterStatsDedupeKey = `batter:${player.playerId}`;
            if (!plateHrV2SufficientStatsCaptured.has(batterStatsDedupeKey)) {
              plateHrV2SufficientStatsCaptured.add(batterStatsDedupeKey);
              const batterStats = captureSufficientStatsIfNeeded(
                "batter", player.playerId, sessionDate, savant?.plateHrV2BatterSufficientStats,
              );
              if (batterStats) plateHrV2SufficientStatsCaptures.push(batterStats);
            }
            const pitcherStatsDedupeKey = opposingPitcher ? `pitcher:${opposingPitcher.pitcherId}` : null;
            if (opposingPitcher && pitcherStatsDedupeKey && !plateHrV2SufficientStatsCaptured.has(pitcherStatsDedupeKey)) {
              plateHrV2SufficientStatsCaptured.add(pitcherStatsDedupeKey);
              const pitcherStats = captureSufficientStatsIfNeeded(
                "pitcher", opposingPitcher.pitcherId, sessionDate,
                pitcherContactByPitcher.has(opposingPitcher.pitcherId)
                  ? (await fetchBaseballSavantData(opposingPitcher.pitcherId, gamePk)).plateHrV2PitcherSufficientStats
                  : null,
              );
              if (pitcherStats) plateHrV2SufficientStatsCaptures.push(pitcherStats);
            }
          } catch (err: any) {
            console.warn(`[PLATE_HR_V2_FORWARD_CAPTURE_FAILED] ${signalId} ${err?.message ?? err}`);
          }
        }

        signals.set(signalId, signal);
        if (scoring.suppressed) {
          suppressedCount++;
          console.log(`[PREGAME_POWER_RADAR_SIGNAL_SUPPRESSED] ${signalId} score=${scoring.score10} reasons=${scoring.suppressedReasons.join(",")}`);
        } else {
          createdPublicEligible++;
          console.log(`[PREGAME_POWER_RADAR_SIGNAL_CREATED] ${signalId} ${player.playerName} ${scoring.tier} score=${scoring.score10} market=${marketTags.primaryMarket}`);
        }
      }

      // Preserve targets for batters who dropped out of the live-fetched
      // batting order since the previous build (pinch hit/run, defensive
      // sub, injury) — carryForwardGradedState above only runs for batters
      // still in `lineup`; without this pass a subbed-out batter's signal
      // (including any already-stamped HR outcome) is silently absent from
      // the rebuilt Map.
      const carriedOver = carryForwardDroppedFromLineup(
        game.gameId,
        resolvedBatterIds,
        prevSignalsByGame.get(game.gameId) ?? [],
        gameStatus,
        firstPitchLockEligible,
        new Date().toISOString(),
        buildId,
      );
      for (const carried of carriedOver) {
        signals.set(carried.signalId, carried);
        console.log(
          `[PREGAME_POWER_RADAR_SIGNAL_CARRIED] ${carried.signalId} ${carried.batterName} dropped from live batting order — preserved (status=${carried.status})`,
        );
      }
    }
  } catch (err: any) {
    console.error(`[PREGAME_POWER_RADAR_BUILD_FAILED] buildId=${buildId}:`, err?.message ?? err);
    isPregamePowerRadarBuildRunning = false;
    return null;
  }

  // Research instrumentation (frozen evaluation snapshots) — runs once over
  // the COMPLETE population after every candidate this cycle has been built
  // and carry-forwarded, so ranks and transitions reflect the whole slate.
  // Never affects score10/tier/drivers/marketScores or public sort/filter.
  try {
    applyEvaluationSnapshots(signals, prevSignals, buildId);
  } catch (err: any) {
    console.warn(`[PREGAME_RADAR_EVALUATION_SNAPSHOT] buildId=${buildId} failed:`, err?.message ?? err);
  }

  const completedAt = new Date().toISOString();
  const snapshot: PregamePowerSnapshot = {
    buildId,
    sessionDate,
    generatedAt: completedAt,
    builtAtMs: Date.now(),
    gamesScanned,
    battersEvaluated,
    signals,
    coverage: {
      lineupCoverage: gamesScanned > 0 ? round2(lineupGames / gamesScanned) : 0,
      weatherCoverage: gamesScanned > 0 ? round2(weatherGames / gamesScanned) : 0,
      batterCoverage: battersEvaluated > 0 ? round2(batterWithPower / battersEvaluated) : 0,
      pitcherCoverage: battersEvaluated > 0 ? round2(pitcherResolved / battersEvaluated) : 0,
    },
  };
  setSnapshot(snapshot);

  console.log(
    `[PREGAME_POWER_RADAR_BUILD_COMPLETE] buildId=${buildId} games=${gamesScanned} ` +
      `batters=${battersEvaluated} public=${createdPublicEligible} suppressed=${suppressedCount}`,
  );

  // Phase 3 — ISO distribution guardrail at the ASSESSMENT BOUNDARY. Counts the
  // complete IsoAssessment collection (every assessIso call), not just signals.
  // Read-only; wrapped so it can never affect the build.
  try {
    const allSignals = Array.from(signals.values());
    const publicSignals = allSignals.filter(isPublicPregameSignal);
    recordAndLogIsoSlateAudit(
      sessionDate,
      buildIsoSlateAudit({
        battersEntering: battersEvaluated,
        assessments: isoAssessments,
        signalsCreated: allSignals.length,
        suppressedSignals: allSignals.length - publicSignals.length,
        displayedSignals: publicSignals,
      }),
    );
  } catch {
    /* observability only — never break the build */
  }

  // ONE aggregate line per build — never one per candidate. Unchanged
  // candidates are never logged at all; only genuine deltas get their own line.
  if (shadowEnabled) {
    console.log(
      `[PLATE_CHALLENGER_EVAL] buildId=${buildId} model=${PLATE_CHALLENGER_POLICY.version} ` +
        `evaluated=${shadowEvaluated} failed=${shadowFailed} deltas=${shadowDeltas} totalMs=${shadowTotalMs}`,
    );
  }
  console.log(
    `[PLATE_CHAMPION_EVAL] buildId=${buildId} model=${PLATE_CHAMPION_POLICY.version} ` +
      `candidates=${battersEvaluated} public=${createdPublicEligible}`,
  );

  // One aggregated line for the whole build, and only when the flagged set
  // actually changed since last time — never a repeat per-signal log every
  // rebuild for a condition that hasn't changed.
  const currentMarketFitAuditSignalIds = new Set(marketFitAuditFlags.map((f) => f.signalId));
  const marketFitAuditSetChanged =
    currentMarketFitAuditSignalIds.size !== previousMarketFitAuditSignalIds.size ||
    Array.from(currentMarketFitAuditSignalIds).some((id) => !previousMarketFitAuditSignalIds.has(id));
  if (marketFitAuditFlags.length > 0 && marketFitAuditSetChanged) {
    console.warn(
      `[PREGAME_MARKET_FIT_AUDIT] buildId=${buildId} ${marketFitAuditFlags.length} flagged: ` +
        marketFitAuditFlags.map((f) => `${f.signalId} (${f.reason})`).join("; "),
    );
  }
  previousMarketFitAuditSignalIds = currentMarketFitAuditSignalIds;

  // Persist (Phase 2 sink) — never blocks/raises into runtime.
  if (buildSink) {
    try {
      await buildSink(Array.from(signals.values()), {
        buildId,
        sessionDate,
        startedAt,
        completedAt,
        gamesScanned,
        battersEvaluated,
        lineupCoverage: snapshot.coverage.lineupCoverage,
        weatherCoverage: snapshot.coverage.weatherCoverage,
        batterCoverage: snapshot.coverage.batterCoverage,
        pitcherCoverage: snapshot.coverage.pitcherCoverage,
        signalsCreated: createdPublicEligible,
        suppressedCount,
      });
    } catch (err: any) {
      console.error(`[PREGAME_POWER_RADAR_DB_UPSERT] sink failed:`, err?.message ?? err);
    }
  }

  // Plate HR Probability V2 (PR 1) — research-only capture flush. Never
  // blocks/raises into runtime; a failure here cannot affect the champion
  // signals already persisted above.
  try {
    await flushPlateHrV2Captures(plateHrV2Captures, { buildId, sessionDate });
    await flushPlateHrV2SufficientStats(plateHrV2SufficientStatsCaptures);
  } catch (err: any) {
    console.error(`[PLATE_HR_V2_FORWARD_CAPTURE_SINK] sink failed:`, err?.message ?? err);
  }

  isPregamePowerRadarBuildRunning = false;
  return snapshot;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
