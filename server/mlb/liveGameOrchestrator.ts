// ── MLB Live Game Orchestrator ────────────────────────────────────────────────
// Central heartbeat of the Phase A MLB engine.
// Discovers games, registers them, polls live data, detects state changes,
// and triggers engine recalculations.

import { discoverTodaysGames } from "./gameDiscoveryService";
import {
  registerGame,
  removeGame,
  getActiveGames,
  getGame,
} from "./liveGameRegistry";
import { mlbEdgeCache } from "./edgeCache";
import {
  syncGameState,
  syncGameBoxScore,
  syncContactData,
  syncPitcherContext,
  syncWeather,
  syncBullpenUsage,
  type ContactChangeEvent,
  syncPitcherSeasonStats,
  syncBatterRollingStats,
  syncBvPMatchup,
  syncSavantSeasonForLineup,
  syncOpenMeteoWeather,
  resolveCurrentHourWeather,
  mlbGameCache,
  mlbPlayerCache,
  type GameStateCache,
  type HRPlayMeta,
} from "./dataPullService";
import { estimateRemainingPA, estimatePitcherRemainingBF } from "./paEstimator";
import { getMarketParkFactor, isVenueIndoors } from "./dataSources";
import { calculateMLBPropEdge, hasRealOdds, canShowSignal, updateSelfLearningCalibration } from "./markets";
import { refreshFullSelfLearning, getLearnedRateAdjustment, getLearnedContactProfile, getContactQualityScore, getPitchTypeHrRisk, getAllCalibrationData } from "./selfLearning";
import { recordMLBDiagnostic } from "./diagnostics";
import type { MLBPropInput, MLBPropOutput, MLBMarket, MLBQualifiedSignal } from "./types";
import { MARKET_QUALIFY_FLOOR, ALL_MLB_MARKETS } from "./types";
import { runIntegrityFirewall, logFirewallResult } from "./integrityFirewall";
import { getCanonicalSidedProbability } from "./probabilityEngine";
import { computeSignalScore, computeSignalScoreByFamily, scoreHRRadar, deriveSignalTags, deriveFeedTags, deriveGameCardTags, isPlayerGlowEligible, derivePitcherSignals, computeFullOpportunityScore, computeLiveOpportunityScore, getMarketFamily, deriveSignalTier } from "./signalScore";
import { detectNearHrContact, detectNearHrContactPeak } from "./nearHrContact";
import { upsertCanonicalHrRadarState } from "./hrRadarCanonicalStore";
import type { HrRadarLifecycleEvent } from "./hrRadarStateMachine";
import { MLB_CALIBRATION_VERSION } from "./diagnosticsBuffer";
import { recordDriftSnapshot } from "./goldmasterGuard";
import {
  beginCycle as auditBeginCycle,
  endCycle as auditEndCycle,
  recordRejection as auditRecordRejection,
  recordQualified as auditRecordQualified,
  recordRawCandidate as auditRecordRaw,
  recordNormalizedCandidate as auditRecordNormalized,
  recordCooldown as auditRecordCooldown,
  recordWatchSurfaced as auditRecordWatchSurfaced,
} from "./qualificationAudit";
import { evaluateShadowBatterOver } from "./shadowQualification";
import type { MarketFamily } from "./signalScore";
import { buildSignalDiagnostics } from "./signalDiagnostics";
import { resolveMLBOddsEventId, getMLBPlayerOdds } from "../oddsService";
import { assignMlbTier, assignAndCheckPoll, markPolled, clearGame as clearScheduler, logTierAssignment, type MlbGameContext } from "../odds/oddsScheduler";
import { clearTier } from "../odds/oddsDiagnostics";
import { readOddsSnapshot, readLastKnownGood } from "../odds/oddsCache";
import { rankBook } from "../odds/oddsConfig";
import {
  classifyBatterArchetype,
  classifyPitcherArchetype,
  generateThesis,
  MARKET_VOLATILITY,
  type MLBBatterArchetype,
  type MLBPitcherArchetype,
} from "./archetypes";
// NOTE: probabilityEngine.applyModelSafetyCeiling is the single authoritative cap layer.
// Orchestrator no longer applies its own ceiling — engine output is trusted.
import { buildLiveEventInterpretation } from "./liveEventInterpretation";
import { applyFamilySuppression } from "./marketFamily";
import { trackSignalDirection } from "./directionalBias";
import { evaluateHRAlert, markAlertSent, clearGameCooldowns, type HRAlertInput } from "./evaluateHRAlert";
import { recomputeHrAlertState, clearGameHrStates, getHrAlertState, mapDynamicStateToStage, computeUnifiedCanonicalStage, seedHrAlertDetection, closeHrAlertOnHit, type HRAlertSnapshot, type HrRadarStage } from "./hrAlertEngine";
import {
  recomputeNonHrSignalState,
  closeNonHrSignalOnHit,
  clearNonHrStatesForGame,
  type NonHrSignalState,
} from "./nonHrSignalState";
import { todayET, dateToET } from "../utils/dateUtils";
import { buildHRSignal } from "./HRSignalBuilder";
import { getPlayer } from "./rosterService";
import { storage } from "../storage";
import { trackPlay } from "../services/playTracker";
import { runFullOnlyHomersScrape, getHotHitters, getLiveBallparkFactors, getBatterVsPitcherHrHistory } from "./onlyHomersService";
// HR Radar Settlement Repair — promote previously-broken `require()` calls to
// ESM static imports. Under ESM the runtime has no `require` global, so
// every prior `require("./hrRadarOutcomeStamp")` etc. was throwing
// `ReferenceError: require is not defined` and being silently swallowed by
// the surrounding try/catch — explaining why bus.cashSignal NEVER fired
// in production despite being in the code path.
import * as hrRadarOutcomeStampMod from "./hrRadarOutcomeStamp";
import * as hrRadarSectionMod from "./hrRadarSection";
import * as hrRadarUserStageMod from "./hrRadarUserStage";
import * as liveSignalBusMod from "../services/liveSignalBus";

// ── HR Presence Floor eligibility thresholds (Task #126 / tuned in #128) ────
// A batter passes the presence floor if ANY of these conditions hold:
//   - seasonHRRate    >= PRESENCE_FLOOR_SEASON_HR_RATE
//   - hrRateLast30    >= PRESENCE_FLOOR_HR_RATE_L30
//   - barrelRate      >= PRESENCE_FLOOR_BARREL_RATE
//   - OnlyHomers hot-hitter list (binary toggle)
//
// Tuned by Task #128 against the 2026 season, window 2026-04-04..2026-04-23
// (882 events, 724 candidates after excluding batter-days that already had
// a real PATH A–E row, 21 uncalled HRs). The full sweep + recommendation
// is captured in `.local/state/presence-floor-tuning.md`. Sweep harness:
// `scripts/backtestPresenceFloor.ts`. Re-run after each fortnight of live
// data to confirm the noise/coverage trade-off has not drifted.
//
// Trade-off vs. the previous (0.025 / 0.030 / 0.080) defaults:
//   - presence rows surfaced: 152 → 93   (~39% less noise)
//   - uncalled HRs covered:    9  →  8   (–1 covered HR)
//   - miss:hr ratio:          15.9 → 10.6 (~33% better)
//   - coverage:               42.9% → 38.1%
// We accept the 1-HR coverage drop because the noise reduction is
// substantial. seasonHRRate and hrRateLast30 are unchanged because the
// barrel axis dominates discrimination on the available data.
export const PRESENCE_FLOOR_SEASON_HR_RATE = 0.025;
export const PRESENCE_FLOOR_HR_RATE_L30 = 0.030;
export const PRESENCE_FLOOR_BARREL_RATE = 0.120;

// ── OnlyHomers data caches (refreshed periodically) ─────────────────────────
let ohHotHitters7d: Map<string, number> = new Map();
let ohHotHitters14d: Map<string, number> = new Map();
let ohHotHitters30d: Map<string, number> = new Map();
let ohBallparkFactors: Map<string, number> = new Map();
let ohLastRefresh = 0;
const OH_REFRESH_MS = 30 * 60_000;

async function refreshSelfLearningCalibration(): Promise<void> {
  try {
    await refreshFullSelfLearning();

    const calData = getAllCalibrationData();
    for (const [market, cal] of Object.entries(calData.marketCalibrations)) {
      updateSelfLearningCalibration(market, cal.actualRate, cal.engineExpectedRate, cal.sampleSize);
    }
  } catch (e: any) {
    console.warn(`[MLB SELF_LEARN] Calibration chain failed: ${e.message}`);
  }
}

export async function refreshOnlyHomersCache(): Promise<void> {
  if (Date.now() - ohLastRefresh < OH_REFRESH_MS) return;
  try {
    const [h7, h14, h30, parks] = await Promise.all([
      getHotHitters("7d"),
      getHotHitters("14d"),
      getHotHitters("30d"),
      getLiveBallparkFactors(),
    ]);
    ohHotHitters7d = new Map(h7.map(h => [h.playerName, h.hrCount]));
    ohHotHitters14d = new Map(h14.map(h => [h.playerName, h.hrCount]));
    ohHotHitters30d = new Map(h30.map(h => [h.playerName, h.hrCount]));
    ohBallparkFactors = parks;
    ohLastRefresh = Date.now();
    console.log(`[OnlyHomers] Cache refreshed — 7d=${ohHotHitters7d.size} 14d=${ohHotHitters14d.size} 30d=${ohHotHitters30d.size} parks=${ohBallparkFactors.size}`);
  } catch (e: any) {
    console.warn(`[OnlyHomers] Cache refresh failed: ${e.message}`);
  }
}

export function getOnlyHomersEnrichment(playerName: string): {
  isHotHitter: boolean;
  hotHitterPeriod: string | null;
  hotHitterHrCount: number | null;
} {
  const hr7 = ohHotHitters7d.get(playerName);
  if (hr7 != null && hr7 >= 2) {
    return { isHotHitter: true, hotHitterPeriod: "7d", hotHitterHrCount: hr7 };
  }
  const hr14 = ohHotHitters14d.get(playerName);
  if (hr14 != null && hr14 >= 3) {
    return { isHotHitter: true, hotHitterPeriod: "14d", hotHitterHrCount: hr14 };
  }
  const hr30 = ohHotHitters30d.get(playerName);
  if (hr30 != null && hr30 >= 5) {
    return { isHotHitter: true, hotHitterPeriod: "30d", hotHitterHrCount: hr30 };
  }
  return { isHotHitter: false, hotHitterPeriod: null, hotHitterHrCount: null };
}

export function getOnlyHomersBallparkHrCount(ballpark: string): number | null {
  return ohBallparkFactors.get(ballpark) ?? null;
}

// ── HR alert grading tracker ──────────────────────────────────────────────────
// Tracks the highest atBatIndex of an HR play we've already graded per
// (gameId, playerId). Using the play's atBatIndex (canonical from MLB Stats API)
// instead of a count avoids race conditions where the box-score HR count
// updates before/after the play feed and produces wrong inning attribution.
const KNOWN_HR_COUNTS = new Map<string, number>();          // legacy: used elsewhere as "we've seen this player's HR"
const KNOWN_HR_AB_INDEX = new Map<string, number>();        // gameId_playerId -> highest graded atBatIndex

// HR Radar audit fix #1 — race-proof "alreadyHit" lookup.
// Stamped synchronously inside gradeSingleHRPlay the moment the play feed
// reports a HR, independent of the box-score sync. Consumers (signal state,
// feed-tag derivation, engine state map) check this set first so a player who
// just hit a HR can never appear as "BET_NOW / fire" while the box-score
// catches up. Cleared at game-final cleanup.
export const RESOLVED_HR_PLAYERS = new Set<string>();       // `${gameId}_${playerId}`

export function isPlayerHrResolved(gameId: string, playerId: string | number): boolean {
  return RESOLVED_HR_PLAYERS.has(`${gameId}_${playerId}`);
}

// MLB Signals audit P1 — race-proof "alreadyHit" for non-HR markets.
// Stamped at engine-tick time the moment the play-feed-derived stat count
// crosses the prop line. Keyed `${gameId}_${playerId}_${market}`.
// Engine and feed paths consult this set before the box-score-driven
// `currentStatValue >= line` check so a card never lingers in the bettable
// feed while the box-score catches up. Cleared at game-final.
export const RESOLVED_NON_HR_MARKETS = new Set<string>();    // `${gameId}_${playerId}_${market}`

// HR Radar Final-Game Reconciliation — once-per-process gate so the
// `live → final` transition fires its log/cache-flush/reconcile branch
// exactly once per game (the underlying status block runs every 10s
// while the game stays final). Cleared in pollGames when the game
// leaves the registry so a same-day re-run also re-fires.
export const MLB_FINAL_LOGGED = new Set<string>();

// ── Daily slate-reset coordinator ────────────────────────────────────────────
// Recurring-bug fix: every cache below is keyed by gameId and was only cleared
// at the per-game `final` transition. When that transition was missed (server
// restart, API hiccup, game removed from registry before final poll), residue
// survived past midnight and poisoned the next slate — which is why MLB
// signals + HR Radar required a manual "reset" every day to start working.
//
// `pruneStaleSlateMemory` is invoked daily at 04:30 ET by the cron in
// `server/index.ts` and on-demand via `/api/admin/mlb/reset-slate-state`.
// It evicts every entry whose gameId is NOT in the live registry, so a
// late-night Pacific game that's still active at 4 AM ET stays untouched.
export async function pruneStaleSlateMemory(reason: string = "daily_cron"): Promise<{
  reason: string;
  activeGames: number;
  removed: Record<string, number>;
  remaining: Record<string, number>;
}> {
  const activeGameIds = new Set(getActiveGames().map((g) => g.gameId));

  const dropByGamePrefix = <V,>(map: Map<string, V> | Set<string>): number => {
    let n = 0;
    const keys = Array.from((map as any).keys ? (map as any).keys() : (map as Set<string>).values());
    for (const key of keys) {
      const sepIdx = (key as string).indexOf("_");
      const gameId = sepIdx > 0 ? (key as string).slice(0, sepIdx) : (key as string);
      if (!activeGameIds.has(gameId)) {
        (map as any).delete(key);
        n++;
      }
    }
    return n;
  };

  // Caches owned by this file
  const removedKnownCounts = dropByGamePrefix(KNOWN_HR_COUNTS);
  const removedKnownAB = dropByGamePrefix(KNOWN_HR_AB_INDEX);
  const removedResolvedHR = dropByGamePrefix(RESOLVED_HR_PLAYERS);
  const removedResolvedNonHR = dropByGamePrefix(RESOLVED_NON_HR_MARKETS);
  let removedFinalLogged = 0;
  for (const gameId of Array.from(MLB_FINAL_LOGGED)) {
    if (!activeGameIds.has(gameId)) { MLB_FINAL_LOGGED.delete(gameId); removedFinalLogged++; }
  }
  let removedHydrated = 0;
  for (const gameId of Array.from(HR_RADAR_HYDRATED_GAMES)) {
    if (!activeGameIds.has(gameId)) { HR_RADAR_HYDRATED_GAMES.delete(gameId); removedHydrated++; }
  }
  let removedLastRun = 0;
  for (const gameId of Array.from(LAST_RUN.keys())) {
    if (!activeGameIds.has(gameId)) { LAST_RUN.delete(gameId); removedLastRun++; }
  }
  let removedRosterScanRun = 0;
  for (const gameId of Array.from(hrRosterScanLastRun.keys())) {
    if (!activeGameIds.has(gameId)) { hrRosterScanLastRun.delete(gameId); removedRosterScanRun++; }
  }
  let removedRosterScanAB = 0;
  for (const gameId of Array.from(hrRosterScanLastABCount.keys())) {
    if (!activeGameIds.has(gameId)) { hrRosterScanLastABCount.delete(gameId); removedRosterScanAB++; }
  }
  // mlbPersistGuard key format: `${playerId}|${market}|${dir}|${gameId}|${date}`
  let removedPersistGuard = 0;
  for (const key of Array.from(mlbPersistGuard.keys())) {
    const parts = key.split("|");
    const gameId = parts.length >= 4 ? parts[3] : "";
    if (!activeGameIds.has(gameId)) { mlbPersistGuard.delete(key); removedPersistGuard++; }
  }
  // priorResolvedLines key format: `${oddsEventId}|${playerNameNorm}|${market}`
  // — not keyed by gameId; safe to drop wholesale at slate reset since the
  // odds service will re-resolve fresh lines on the next tick.
  const priorResolvedSize = priorResolvedLines.size;
  priorResolvedLines.clear();

  // Caches owned by sibling modules
  const { clearStaleNonHrStates, getNonHrSignalStateSize } = await import("./nonHrSignalState");
  const { clearStaleHrAlertStates, getHrAlertStateMapSize } = await import("./hrAlertEngine");
  const { clearStaleAlertCooldowns, getRecentAlertsSize } = await import("./evaluateHRAlert");
  const { pruneStaleSessionDates, getMlbGameSessionDateCacheSize } = await import("../utils/mlbSessionDate");
  const { todayET, daysAgoET } = await import("../utils/dateUtils");

  const removedNonHr = clearStaleNonHrStates(activeGameIds);
  const removedHrAlertEngine = clearStaleHrAlertStates(activeGameIds);
  const removedCooldowns = clearStaleAlertCooldowns(activeGameIds);
  const removedSessionDates = pruneStaleSessionDates(new Set([todayET(), daysAgoET(1)]));

  // Edge cache prunes by registry on every write; force one sweep here too.
  const { cleanupExpiredEntries } = await import("./edgeCache");
  cleanupExpiredEntries();

  const removed = {
    KNOWN_HR_COUNTS: removedKnownCounts,
    KNOWN_HR_AB_INDEX: removedKnownAB,
    RESOLVED_HR_PLAYERS: removedResolvedHR,
    RESOLVED_NON_HR_MARKETS: removedResolvedNonHR,
    MLB_FINAL_LOGGED: removedFinalLogged,
    HR_RADAR_HYDRATED_GAMES: removedHydrated,
    LAST_RUN: removedLastRun,
    hrRosterScanLastRun: removedRosterScanRun,
    hrRosterScanLastABCount: removedRosterScanAB,
    mlbPersistGuard: removedPersistGuard,
    priorResolvedLines: priorResolvedSize,
    nonHrSignalState: removedNonHr,
    hrAlertEngineStateMap: removedHrAlertEngine,
    evaluateHRAlertCooldowns: removedCooldowns,
    sessionDateByGameId: removedSessionDates,
  };

  const remaining = {
    KNOWN_HR_COUNTS: KNOWN_HR_COUNTS.size,
    KNOWN_HR_AB_INDEX: KNOWN_HR_AB_INDEX.size,
    RESOLVED_HR_PLAYERS: RESOLVED_HR_PLAYERS.size,
    RESOLVED_NON_HR_MARKETS: RESOLVED_NON_HR_MARKETS.size,
    MLB_FINAL_LOGGED: MLB_FINAL_LOGGED.size,
    HR_RADAR_HYDRATED_GAMES: HR_RADAR_HYDRATED_GAMES.size,
    LAST_RUN: LAST_RUN.size,
    hrRosterScanLastRun: hrRosterScanLastRun.size,
    hrRosterScanLastABCount: hrRosterScanLastABCount.size,
    mlbPersistGuard: mlbPersistGuard.size,
    priorResolvedLines: priorResolvedLines.size,
    nonHrSignalState: getNonHrSignalStateSize(),
    hrAlertEngineStateMap: getHrAlertStateMapSize(),
    evaluateHRAlertCooldowns: getRecentAlertsSize(),
    sessionDateByGameId: getMlbGameSessionDateCacheSize(),
    activeGames: activeGameIds.size,
  };

  const totalRemoved = Object.values(removed).reduce((a, b) => a + b, 0);
  console.log(`[MLB_SLATE_RESET] reason=${reason} activeGames=${activeGameIds.size} totalRemoved=${totalRemoved} removed=${JSON.stringify(removed)} remaining=${JSON.stringify(remaining)}`);

  return { reason, activeGames: activeGameIds.size, removed, remaining };
}

export function isPlayerMarketResolved(
  gameId: string,
  playerId: string | number,
  market: string
): boolean {
  return RESOLVED_NON_HR_MARKETS.has(`${gameId}_${playerId}_${market}`);
}

// Compute a play-feed-derived stat count for a single batter market by
// walking `priorABResults` (populated synchronously by syncContactData on
// every poll, before the box-score sync completes). This is the canonical
// "freshest possible" count for the at-bat that just ended.
//
// Returns 0 when no contact data exists yet for this player.
//
// Pitcher markets (pitcher_strikeouts, pitcher_outs, hits_allowed, etc.) are
// keyed by the pitcher's playerId and need a separate per-pitcher tally;
// this helper covers batter markets only (P1 scope).
export function getPlayFeedBatterStatCount(
  gameId: string,
  playerId: string,
  market: string
): number {
  const contact = mlbGameCache.contactData?.[gameId]?.byPlayerId?.[playerId];
  if (!contact) return 0;
  const abs = contact.priorABResults ?? [];
  if (abs.length === 0) return 0;

  switch (market) {
    case "hits": {
      let n = 0;
      for (const ab of abs) if (ab.outcome === "hit") n++;
      return n;
    }
    case "home_runs": {
      let n = 0;
      for (const ab of abs) if (ab.hitType === "home_run") n++;
      return n;
    }
    case "total_bases": {
      let n = 0;
      for (const ab of abs) {
        if (ab.hitType === "single") n += 1;
        else if (ab.hitType === "double") n += 2;
        else if (ab.hitType === "triple") n += 3;
        else if (ab.hitType === "home_run") n += 4;
      }
      return n;
    }
    case "hrr": {
      // Hits + Runs + RBI per the standard book market. Run-scored on this
      // play (batter himself crossing home) + the play's RBI total.
      let hits = 0;
      let rbi = 0;
      let runs = 0;
      for (const ab of abs) {
        if (ab.outcome === "hit") hits++;
        rbi += ab.rbi ?? 0;
        if (ab.runScored) runs++;
      }
      return hits + rbi + runs;
    }
    case "batter_strikeouts": {
      let n = 0;
      for (const ab of abs) if (ab.outcome === "strikeout") n++;
      return n;
    }
    default:
      return 0;
  }
}

// Stamp the resolved-set when a (player, market) crosses its prop line.
// Idempotent — only logs the first crossing per key. Called from the engine
// market-input builder so we have the line in scope.
export function maybeMarkNonHrResolved(
  gameId: string,
  playerId: string,
  playerName: string,
  market: string,
  line: number,
  playFeedStat: number
): void {
  if (line <= 0) return;
  if (playFeedStat < line) return;
  const key = `${gameId}_${playerId}_${market}`;
  if (RESOLVED_NON_HR_MARKETS.has(key)) return;
  RESOLVED_NON_HR_MARKETS.add(key);
  console.log(
    `[NON_HR_RESOLVED] gameId=${gameId} playerId=${playerId} player=${playerName} ` +
    `market=${market} line=${line} playFeedStat=${playFeedStat}`
  );
  // MLB Signals audit P2 — flip the engine state machine to CLOSED in the
  // same tick. Belt-and-suspenders: computeSignalState also passes
  // resolvedNow=true on the next recompute, but stamping here closes any
  // race where the resolved-set is set before the next computeSignalState.
  closeNonHrSignalOnHit(gameId, playerId, market, "play_feed_crossed_line");
}

function gradeSingleHRPlay(
  playerId: string,
  gameId: string,
  playerName: string,
  team: string,
  inning: number,
  halfInning: "top" | "bottom",
  atBatIndex: number,
  endTimeMs: number | null,
  source: "play_feed" | "box_score_fallback",
): void {
  const hitHalf = halfInning === "top" ? "T" : "B";
  const hitLabel = `${hitHalf}${inning}`;
  const ageSec = endTimeMs ? Math.round((Date.now() - endTimeMs) / 1000) : null;
  console.log(
    `[HR_GRADE_DETECTED] playerId=${playerId} player=${playerName} gameId=${gameId} ` +
    `hitLabel=${hitLabel} abIndex=${atBatIndex} source=${source}` +
    (ageSec !== null ? ` ageSec=${ageSec}` : "")
  );
  // Goldmaster Spec Step 3 — canonical event-detected log alias.
  // Co-exists with [HR_GRADE_DETECTED] so existing log consumers are unchanged
  // while new ones can grep on the canonical name. The two source enums map
  // 1:1: "play_feed" → HR_RADAR_HR_EVENT_DETECTED, "box_score_fallback" →
  // HR_RADAR_BOXSCORE_HR_FALLBACK.
  const canonicalEvent = source === "play_feed" ? "HR_RADAR_HR_EVENT_DETECTED" : "HR_RADAR_BOXSCORE_HR_FALLBACK";
  console.log(
    `[${canonicalEvent}] gameId=${gameId} playerId=${playerId} player=${playerName} ` +
    `inning=${inning} half=${halfInning} hitLabel=${hitLabel} abIndex=${atBatIndex}` +
    (ageSec !== null ? ` ageSec=${ageSec}` : "")
  );
  // HR Radar audit fix #1 — stamp resolved set immediately, before any DB I/O,
  // so any in-flight signal generation in this same tick sees the player as
  // hit even if the box-score has not refreshed yet.
  RESOLVED_HR_PLAYERS.add(`${gameId}_${playerId}`);
  // HR Radar audit fix #3 — terminal close on the in-memory engine state map
  // so subsequent recompute ticks short-circuit and the player can never
  // re-enter BET_NOW after the HR. Idempotent.
  closeHrAlertOnHit(gameId, playerId);
  // ── HR Radar Lifecycle Repair Fix #2 — CASHED linkage ──────────────────
  // The forensic audit found that closeHrAlertOnHit set the engine state to
  // CLOSED but `deriveHrRadarLifecycleState` mapped CLOSED → "inactive", not
  // "cashed". So no card ever reached the cashed bucket. We now do two things
  // synchronously alongside the existing close:
  //   (a) Stamp an in-memory outcome record keyed by gameId_playerId. The
  //       deriveHrRadarOutcomeStatus helper consults this stamp as a
  //       fallback so the cashed bucket populates even before the DB grading
  //       row is written or the box-score has caught up.
  //   (b) Best-effort apply the canonical lifecycle "cashed" event to the
  //       liveSignalBus / lifecycleStore by signalId so the canonical
  //       lifecycle stays in sync. Wrapped in try/catch — a rejected
  //       transition (e.g. signal not yet registered, or in `watch` state
  //       which can't go directly to cashed) is logged and ignored. Never
  //       blocks the close path.
  try {
    const snap = getHrAlertState(gameId, playerId);
    // HRAlertResult exposes alertTier + signalState (the engine's two
    // surfaced taxonomies). Legacy `confidenceTier` is not on the snapshot
    // — inferCashedFromTierStatus tolerates it being null and falls back
    // to alertTier-driven mapping (officialAlert/prepare/watch).
    const alertTier = snap?.alertResult?.alertTier ?? null;
    const signalState = snap?.alertResult?.signalState ?? null;
    const tieredStatus = (() => {
      try {
        return hrRadarSectionMod.inferCashedFromTierStatus({
          alertTier,
          confidenceTier: null,
          signalState,
        });
      } catch {
        return "called_hit" as const;
      }
    })();
    hrRadarOutcomeStampMod.stampHrRadarOutcome(gameId, playerId, tieredStatus, {
      hitInning: inning,
      alertTier,
      confidenceTier: null,
      signalState,
      source,
    });
  } catch (err) {
    console.warn(`[HR_RADAR_CASHED] stamp failed gameId=${gameId} playerId=${playerId} err=${(err as Error).message}`);
  }
  try {
    // HR Radar Settlement Repair — Bug #1: the canonical MLB market token for
    // the HR Radar signal is `hrr` (see `mlbSignalId()` + production logs:
    // `mlb:<gameId>:<playerId>:hrr:OVER`). Previously this was hardcoded to
    // `home_runs`, so `getCanonical(signalId)` returned null and the cash was
    // silently dropped. We try the canonical token first; the legacy
    // `home_runs` form is also attempted for back-compat with any signal
    // path that might still register under that market.
    liveSignalBusMod.cashSignal(`mlb:${gameId}:${playerId}:hrr:OVER`, `HR observed inning=${inning} half=${halfInning}`);
    liveSignalBusMod.cashSignal(`mlb:${gameId}:${playerId}:home_runs:OVER`, `HR observed inning=${inning} half=${halfInning}`);
  } catch (err) {
    console.warn(`[HR_RADAR_CASHED] lifecycle apply failed gameId=${gameId} playerId=${playerId} err=${(err as Error).message}`);
  }
  // HR Radar Settlement Repair — Bug #6: same-tick race protection. If the
  // engine had this player past PATH A-E (alertTier ∈ {prepare, official_alert}
  // OR signalState ∈ {actionable, fire}) at the moment of HR detection, but
  // the engine's qualifying-event write hasn't committed yet, the matcher
  // would fall to timestamp-rescue (or fail entirely) and the cash would be
  // graded as `late_signal` / `uncalled_hr`. We synchronously persist a
  // synthetic qualifying signal_event row anchored to the prior tick (so it
  // strictly precedes hrEnd) — additive, never replaces a real engine event.
  try {
    const snap = getHrAlertState(gameId, playerId);
    const alertTier = snap?.alertResult?.alertTier ?? null;
    const signalState = snap?.alertResult?.signalState ?? null;
    const wasQualified =
      alertTier === "officialAlert" ||
      alertTier === "prepare" ||
      signalState === "PEAK" ||
      signalState === "BUILDING";
    if (wasQualified && endTimeMs && endTimeMs > 0) {
      // Anchor 1s before HR endTime so it strictly precedes hrEnd in the
      // matcher's `lt(hrRadarSignalEvents.detectedAt, new Date(hrEnd))`.
      const anchor = new Date(endTimeMs - 1000);
      const eventType =
        alertTier === "officialAlert" || signalState === "PEAK"
          ? "stage_attack"
          : "stage_building";
      void storage.appendHrRadarSignalEvent({
        sessionDate: undefined as any,
        gameId,
        playerId,
        team,
        alertId: null,
        eventType,
        detectedAt: anchor,
        inning,
        half: hitHalf,
        source: "grader_pre_close",
      } as any).catch(() => {});
      console.log(`[HR_RADAR_PRE_CLOSE_QUALIFY] playerId=${playerId} gameId=${gameId} eventType=${eventType} alertTier=${alertTier} signalState=${signalState} anchorMs=${endTimeMs - 1000}`);
    }
  } catch (err) {
    // Never block the grading path on the synthetic-event fallback.
  }
  storage.resolveAlertAsHit(playerId, gameId, inning, halfInning, atBatIndex, endTimeMs).catch(() => {});
  storage.resolveHrRadarAlertAsHit(playerId, gameId, inning, hitHalf, hitLabel, endTimeMs)
    .then((count) => {
      if (count === 0) {
        storage.ensureHrRadarAlertHit({
          gameId,
          playerId,
          playerName,
          team,
          inning,
          half: halfInning,
          hitLabel,
          // Phase 2 — game-level AB index. atBatIndex===0 (first AB of the
          // game) qualifies for the early-HR-insufficient-sample exemption
          // even outside inning 1.
          atBatIndex,
        }).catch(err => console.warn(`[HR_RADAR_ENSURE_HIT] Failed: ${err.message}`));
      }
    }).catch(() => {});
}

/**
 * Centralized HR grading using the MLB Stats API live-feed play data.
 * Razor-sharp inning attribution: pulls inning/halfInning directly from each
 * HR play's `about.inning`/`about.halfInning` rather than the orchestrator's
 * current `state.inning` (which may have rolled over by the time we poll).
 *
 * Runs once per pollGame after syncContactData has populated mlbGameCache.hrPlays.
 */
function gradeHomeRunsFromPlays(gameId: string): void {
  const hrCache = mlbGameCache.hrPlays[gameId];
  if (!hrCache || hrCache.plays.length === 0) return;

  // Group plays by playerId, keep highest atBatIndex per player
  const byPlayer = new Map<string, typeof hrCache.plays>();
  for (const p of hrCache.plays) {
    const arr = byPlayer.get(p.playerId) ?? [];
    arr.push(p);
    byPlayer.set(p.playerId, arr);
  }

  for (const [playerId, plays] of Array.from(byPlayer.entries())) {
    plays.sort((a: HRPlayMeta, b: HRPlayMeta) => a.atBatIndex - b.atBatIndex);
    const trackerKey = `${gameId}_${playerId}`;
    const lastGradedIdx = KNOWN_HR_AB_INDEX.get(trackerKey) ?? -1;

    let cumulativeHR = KNOWN_HR_COUNTS.get(trackerKey) ?? 0;
    for (const play of plays) {
      if (play.atBatIndex <= lastGradedIdx) continue;
      // Prefer completed plays for grading; in-progress plays are noted but not graded yet
      if (!play.isComplete) continue;
      cumulativeHR += 1;
      gradeSingleHRPlay(
        playerId,
        gameId,
        play.playerName,
        play.team,
        play.inning,
        play.halfInning,
        play.atBatIndex,
        play.endTimeMs,
        "play_feed",
      );
      KNOWN_HR_AB_INDEX.set(trackerKey, play.atBatIndex);
    }
    if (cumulativeHR > 0) KNOWN_HR_COUNTS.set(trackerKey, cumulativeHR);
  }
}

// Task #121 Step 1 — per-process set of games whose HR-radar detection state
// has been hydrated from DB after boot. Prevents re-hydration on every poll.
const HR_RADAR_HYDRATED_GAMES = new Set<string>();

// ── HR canonical-stage (Goldmaster Phase 5 — unified pipeline) ──────────────
// Phase 4.5 introduced an orchestrator-level `bridgeCanonicalStage` band-aid
// that took max(dynamicStage, PATH_signalState). Phase 5 collapses the two
// parallel scoring systems into ONE pipeline inside `hrAlertEngine.ts`:
//   1. Lower dynamic thresholds (BET_NOW=0.10, PREPARE=0.06) so the
//      probability rail agrees with PATH more often.
//   2. PATH PEAK / BUILDING is folded into the engine snapshot via
//      `computeUnifiedCanonicalStage`, exposed as `snapshot.canonicalStage`.
//
// The orchestrator now reads `snapshot.canonicalStage` directly. There is no
// longer a separate bridge function here — the engine guarantees:
//   - CLOSED is terminal (closed alerts never reopen on a PATH PEAK).
//   - Cooling/building are peers; only a PATH PEAK outranks cooling.
//   - One stage per recompute, persisted into `dynamicReadinessScore`,
//     `confidenceTier`, and `stageContract.currentCanonicalStage` downstream.

// ── Engine dedup lock ─────────────────────────────────────────────────────────
const LAST_RUN = new Map<string, number>();
const DEDUP_WINDOW_MS = 15_000;

function shouldSkip(gameId: string): boolean {
  const last = LAST_RUN.get(gameId);
  if (last === undefined) return false;
  return Date.now() - last < DEDUP_WINDOW_MS;
}

// ── Debug pipeline logging ────────────────────────────────────────────────────
const DEBUG_PIPELINE = process.env.DEBUG_PIPELINE === "true";
function pLog(gameId: string, stage: string, payload: unknown): void {
  if (!DEBUG_PIPELINE) return;
  console.log(`[PIPELINE][MLB][${gameId}] ${stage}:`, JSON.stringify(payload));
}

// ── Engine input guard-rail ───────────────────────────────────────────────────
// Returns null (with a log) if required fields are missing or invalid.
function validateMLBInput(input: MLBPropInput): string | null {
  if (!input.playerName) return "missing playerName";
  if (!isFinite(input.bookLine) || input.bookLine <= 0) return `invalid bookLine=${input.bookLine}`;
  if (!input.gameId) return "missing gameId";
  if (!input.market) return "missing market";
  return null; // valid
}

// ── Market scoping ────────────────────────────────────────────────────────────

const BATTER_MARKETS: MLBMarket[] = [
  "hits",
  "total_bases",
  "home_runs",
  "hrr",
];

const PITCHER_MARKETS: MLBMarket[] = ["pitcher_strikeouts", "pitcher_outs", "hits_allowed"];

// ── Previously-resolved line cache ───────────────────────────────────────────
// Persists the last successfully fetched sportsbook line per event+player+market
// within this server process. Used as the second-priority fallback when the
// odds service is unreachable or has no line posted yet.
// Key: "oddsEventId|playerNameNorm|market" — Value: last known real line
const priorResolvedLines = new Map<string, number>();

// Preferred bookmaker order for deterministic line selection (matches manual flow).
// First match wins; unlisted bookmakers are used only as a last resort.
const PREFERRED_BOOKMAKERS = ["draftkings", "fanduel", "hardrockbet", "betmgm", "betrivers", "espnbet"];

type ResolvedLine = { line: number; overOdds: number | null; underOdds: number | null; isDegraded: boolean; source: "live" | "prior" | "cache" | "lkg" };

// ── Resolve a real book line for a player/market ──────────────────────────────
// Precedence:
//   (1) Odds service live/cached line (getMLBPlayerOdds) — preferred book order
//       isDegraded=true when odds service served a stale last-known-good cache
//   (2) Previously resolved line cache (real market line from earlier in session)
//       isDegraded=true since it is not the current live quote
//   (3) null — no compliant line available; caller must skip this market
//
// Synthetic/default hardcoded lines are NOT used. Markets without a real line
// are explicitly skipped to avoid invalidated edge calculations.
async function resolveBookLine(
  oddsEventId: string | null,
  playerName: string,
  market: MLBMarket
): Promise<ResolvedLine | null> {
  const normName = playerName.toLowerCase().trim();
  const cacheKey = oddsEventId ? `${oddsEventId}|${normName}|${market}` : `unknown|${normName}|${market}`;

  // (0) Cache-first: serve from shared odds cache when fresh — avoids API hit.
  //     Try in-play first (more relevant during live games), then pre-game.
  if (oddsEventId) {
    for (const inPlay of [true, false]) {
      const snap = readOddsSnapshot({ sport: "mlb", eventId: oddsEventId, market, player: playerName, isLive: inPlay });
      if (snap && snap.freshness === "fresh") {
        const bookKeys = Object.keys(snap.books);
        const preferred = bookKeys.slice().sort((a, b) => rankBook("mlb", a) - rankBook("mlb", b))[0];
        const entry = snap.books[preferred];
        if (entry && typeof entry.line === "number" && isFinite(entry.line) && entry.line > 0) {
          priorResolvedLines.set(cacheKey, entry.line);
          pLog(oddsEventId, `odds:bookLine:cache:${inPlay ? "inPlay" : "pre"}`, { player: playerName, market, line: entry.line, book: preferred, ageMs: snap.ageMs, freshness: snap.freshness });
          return {
            line: entry.line,
            overOdds: typeof entry.overOdds === "number" && isFinite(entry.overOdds) ? entry.overOdds : null,
            underOdds: typeof entry.underOdds === "number" && isFinite(entry.underOdds) ? entry.underOdds : null,
            isDegraded: false,
            source: "cache",
          };
        }
      }
    }
  }

  // (1) Try odds service — first pre-game, then in-play
  //     Only short-circuit on non-degraded pre-game lines; if pre-game returns
  //     degraded/stale data, continue to try in-play for a fresher quote.
  if (oddsEventId) {
    let bestDegraded: ResolvedLine | null = null;
    for (const inPlay of [false, true]) {
      try {
        const oddsResult = await getMLBPlayerOdds(oddsEventId, playerName, market, inPlay);
        const bookKeys = Object.keys(oddsResult).filter(k => !k.startsWith("_"));
        const isOddsDegraded = !!(oddsResult._isDegraded);
        if (bookKeys.length > 0) {
          const preferred = PREFERRED_BOOKMAKERS.find(b => bookKeys.includes(b)) ?? bookKeys[0];
          const entry = oddsResult[preferred];
          const line = entry.line;
          if (typeof line === "number" && isFinite(line) && line > 0) {
            const resolved: ResolvedLine = {
              line,
              overOdds: typeof entry.overOdds === "number" && isFinite(entry.overOdds) ? entry.overOdds : null,
              underOdds: typeof entry.underOdds === "number" && isFinite(entry.underOdds) ? entry.underOdds : null,
              isDegraded: isOddsDegraded,
              source: isOddsDegraded ? "prior" : "live",
            };
            if (!isOddsDegraded) {
              priorResolvedLines.set(cacheKey, line);
              pLog(oddsEventId, `odds:bookLine:${inPlay ? "inPlay" : "live"}`, { player: playerName, market, line, book: preferred });
              return resolved;
            }
            if (!bestDegraded) bestDegraded = resolved;
          }
        }
      } catch (err: any) {
        console.warn(`[MLB orchestrator] resolveBookLine odds error for ${playerName}/${market} (inPlay=${inPlay}):`, err.message);
      }
    }
    if (bestDegraded) {
      priorResolvedLines.set(cacheKey, bestDegraded.line);
      pLog(oddsEventId, "odds:bookLine:degraded", { player: playerName, market, line: bestDegraded.line });
      return bestDegraded;
    }

    // (1.5) Last-known-good fallback from shared cache — even if stale/expired.
    for (const inPlay of [true, false]) {
      const lkg = readLastKnownGood({ sport: "mlb", eventId: oddsEventId, market, player: playerName, isLive: inPlay });
      if (lkg) {
        const bookKeys = Object.keys(lkg.books);
        const preferred = bookKeys.slice().sort((a, b) => rankBook("mlb", a) - rankBook("mlb", b))[0];
        const entry = lkg.books[preferred];
        if (entry && typeof entry.line === "number" && isFinite(entry.line) && entry.line > 0) {
          priorResolvedLines.set(cacheKey, entry.line);
          pLog(oddsEventId, "odds:bookLine:lkg", { player: playerName, market, line: entry.line, book: preferred, ageMs: lkg.ageMs, freshness: lkg.freshness });
          return {
            line: entry.line,
            overOdds: typeof entry.overOdds === "number" && isFinite(entry.overOdds) ? entry.overOdds : null,
            underOdds: typeof entry.underOdds === "number" && isFinite(entry.underOdds) ? entry.underOdds : null,
            isDegraded: true,
            source: "lkg",
          };
        }
      }
    }
  }

  // (2) Fall back to previously resolved line (real market line from earlier in session — stale)
  const prior = priorResolvedLines.get(cacheKey);
  if (prior !== undefined) {
    console.warn(`[MLB orchestrator] Using prior known line for ${playerName}/${market}: ${prior}`);
    pLog(oddsEventId ?? "unknown", "odds:bookLine:priorResolved", { player: playerName, market, line: prior });
    return { line: prior, overOdds: null, underOdds: null, isDegraded: true, source: "prior" };
  }

  console.log(`[MLB orchestrator] No real line for ${playerName}/${market} — SKIPPED`);
  pLog(oddsEventId ?? "unknown", "odds:bookLine:skipped", { player: playerName, market, reason: "noLineAvailable" });
  return null;
}

// ── MLB status normalization ──────────────────────────────────────────────────
export function normalizeMlbStatus(raw: string | undefined): "live" | "pregame" | "final" | "unknown" {
  if (!raw) return "unknown";
  const s = raw.toLowerCase().replace(/[\s_-]/g, "").replace(/^status/, "");
  if (s === "live" || s === "inprogress" || s === "halftime" || s === "delayed") return "live";
  if (s === "preview" || s === "pregame" || s === "scheduled") return "pregame";
  if (s === "final" || s === "gameover" || s === "completed" || s === "fulltime" || s === "postponed" || s === "canceled" || s === "cancelled") return "final";
  return "unknown";
}

// ── State change trigger types ────────────────────────────────────────────────

export type StateChangeTrigger =
  | "new_ab"
  | "ab_completed"
  | "ball_in_play"
  | "inning_change"
  | "pitcher_change"
  | "runner_change"
  | "pitch_count_threshold"
  | "tto_shift"
  | "lineup_substitution"
  | "hard_hit_event"
  | "out_recorded"
  | "score_change"
  | "odds_update"
  | "heartbeat_refresh";

const HIGH_IMPACT_TRIGGERS = new Set<StateChangeTrigger>([
  "new_ab", "ab_completed", "inning_change", "pitcher_change",
  "tto_shift", "lineup_substitution", "out_recorded", "score_change",
]);

const TRIGGER_IMPACTED_MARKETS: Record<StateChangeTrigger, MLBMarket[] | "all"> = {
  new_ab: "all",
  ab_completed: "all",
  ball_in_play: ["hits", "total_bases", "home_runs", "hrr", "hits_allowed"],
  inning_change: "all",
  pitcher_change: "all",
  runner_change: ["hits", "total_bases", "hrr"],
  pitch_count_threshold: ["pitcher_strikeouts", "pitcher_outs", "hits_allowed"],
  tto_shift: "all",
  lineup_substitution: "all",
  hard_hit_event: ["hits", "total_bases", "home_runs", "hrr", "hits_allowed"],
  out_recorded: "all",
  score_change: "all",
  odds_update: "all",
  // Heartbeat backstop — see HEARTBEAT_RECOMPUTE in pollGame. Recomputes all
  // markets when the engine has gone >45s without a real state-change trigger
  // so the cache `updatedAt` reflects a real run, not a fake refresh.
  heartbeat_refresh: "all",
};

// ── Polling intervals ─────────────────────────────────────────────────────────

const GAME_DISCOVERY_MS = 5 * 60 * 1000;   // 5 minutes
const GAME_STATE_MS = 10 * 1000;            // 10 seconds (via pollGame)
const WEATHER_MS = 10 * 60 * 1000;          // 10 minutes

// ── Orchestrator class ────────────────────────────────────────────────────────

const HR_ROSTER_SCAN_INTERVAL_MS = 3 * 60 * 1000;
const hrRosterScanLastRun = new Map<string, number>();
const hrRosterScanLastABCount = new Map<string, number>();

// Goldmaster Spec Step 6 — periodic HR Radar reconcile cadence.
// Belt-and-suspenders for the existing 10s state poll: if the play feed
// lags or the orchestrator's `gradeHomeRunsFromPlays` was skipped (scheduler
// tier downgrade, in-flight dedupe), this 20s tick re-runs the idempotent
// per-play grader using the existing `KNOWN_HR_AB_INDEX` dedup map so the
// same HR is never graded twice. Game-final reconcile is unchanged — it
// still fires inside `_pollGameInner` when status flips to "final".
const HR_RADAR_RECONCILE_MS = 20 * 1000;

export class LiveGameOrchestrator {
  private timers: ReturnType<typeof setInterval>[] = [];
  private previousStates: Map<string, GameStateCache> = new Map();
  private pollInFlight: Set<string> = new Set();

  start(): void {
    console.log("[MLB orchestrator] Starting...");

    // Initial discovery
    this.pollGames().catch(console.error);

    this.timers.push(
      setInterval(() => {
        this.pollGames().catch(console.error);
        resetDailyPersistGuard();
      }, GAME_DISCOVERY_MS)
    );

    // Game state + contact + pitcher context — gated by sport-aware scheduler tier
    this.timers.push(
      setInterval(() => {
        for (const game of getActiveGames()) {
          const ctx = this.buildMlbContext(game.gameId);
          const tier = assignMlbTier(ctx);
          const decision = assignAndCheckPoll("mlb", game.gameId, tier);
          if (!decision.shouldPoll) continue;
          markPolled("mlb", game.gameId, tier);
          this.pollGame(game.gameId).catch(console.error);
        }
      }, GAME_STATE_MS)
    );

    // Weather every 10 minutes — only for games with a resolved gamePk
    this.timers.push(
      setInterval(() => {
        for (const game of getActiveGames()) {
          if (!game.gamePk) continue;
          syncWeather(game.gamePk, game.gameId).catch(console.error);
          const venueName = mlbGameCache.weather[game.gameId]?.venueName ?? null;
          syncOpenMeteoWeather(game.gameId, venueName).catch(console.error);
        }
      }, WEATHER_MS)
    );

    runFullOnlyHomersScrape().then(() => refreshOnlyHomersCache()).catch(console.error);
    refreshSelfLearningCalibration().catch(console.error);

    this.timers.push(
      setInterval(() => {
        runFullOnlyHomersScrape().then(() => refreshOnlyHomersCache()).catch(console.error);
      }, 60 * 60_000)
    );

    this.timers.push(
      setInterval(() => {
        refreshSelfLearningCalibration().catch(console.error);
      }, 30 * 60_000)
    );

    // Goldmaster Spec Steps 6-7 — periodic HR Radar reconcile loop.
    // Runs every 20s for each active live game and re-triggers the
    // idempotent per-play HR grader. The grader uses the per-process
    // `KNOWN_HR_AB_INDEX` map so each HR is only stamped once even when
    // this loop and the 10s state poll race.
    let hrRadarIdleTickCount = 0;
    this.timers.push(
      setInterval(() => {
        const tickStart = Date.now();
        const games = getActiveGames();
        let liveGames = 0;
        for (const game of games) {
          const status = normalizeMlbStatus(game.espnStatus);
          if (status !== "live") continue;
          liveGames += 1;
          this.reconcileHrRadarLiveGame(game.gameId).catch((err) =>
            console.warn(`[HR_RADAR_RECONCILE_GAME] gameId=${game.gameId} error=${err.message}`)
          );
        }
        if (liveGames > 0) {
          hrRadarIdleTickCount = 0;
          console.log(`[HR_RADAR_RECONCILE_TICK] liveGames=${liveGames} totalGames=${games.length} tookMs=${Date.now() - tickStart}`);
        } else {
          // Phase 9.4 — heartbeat. Emit one idle log every ~5 min (15 ticks
          // × 20s) so admins can verify the reconcile loop is alive even
          // when no games are currently live. Without this, total silence
          // for 6+ hours/day was indistinguishable from a stalled timer.
          hrRadarIdleTickCount += 1;
          if (hrRadarIdleTickCount % 15 === 0) {
            console.log(`[HR_RADAR_RECONCILE_IDLE] no live games (totalRegistered=${games.length}, idleTicks=${hrRadarIdleTickCount})`);
          }
        }
      }, HR_RADAR_RECONCILE_MS)
    );

    // Catch-up pass at server start: one-shot reconcile per active live game
    // ~5s after boot. Covers the case where the process restarts mid-game and
    // the 10s state poll hasn't ticked yet but HR plays are already in cache.
    setTimeout(() => {
      const games = getActiveGames();
      let count = 0;
      for (const game of games) {
        const status = normalizeMlbStatus(game.espnStatus);
        if (status !== "live") continue;
        count += 1;
        this.reconcileHrRadarLiveGame(game.gameId).catch((err) =>
          console.warn(`[HR_RADAR_RECONCILE_GAME] (startup) gameId=${game.gameId} error=${err.message}`)
        );
      }
      if (count > 0) {
        console.log(`[HR_RADAR_RECONCILE_TICK] (startup catch-up) liveGames=${count}`);
      }
    }, 5_000);

    console.log(`[MLB orchestrator] Started — discovery ${GAME_DISCOVERY_MS / 1000}s, state/contact/pitcher ${GAME_STATE_MS / 1000}s, weather ${WEATHER_MS / 1000}s, hr-radar-reconcile ${HR_RADAR_RECONCILE_MS / 1000}s, OnlyHomers=hourly, calibration=30min`);
  }

  /**
   * Goldmaster Spec Step 6 — per-game HR Radar reconcile.
   *
   * Idempotent: re-runs the play-feed-driven `gradeHomeRunsFromPlays` against
   * the in-memory `mlbGameCache.hrPlays[gameId]` cache. The grader's atBatIndex
   * dedup map (`KNOWN_HR_AB_INDEX`) guarantees each HR is stamped exactly
   * once across this reconcile loop AND the 10s state poll. If the cache is
   * empty (no HR yet, or game pre-snapshot) this is a no-op.
   *
   * NEVER touches grading/persistence directly — that is owned by
   * `gradeSingleHRPlay` → `storage.resolveHrRadarAlertAsHit`. This wrapper
   * only re-triggers detection so a missed 10s poll doesn't leave a stale row.
   */
  async reconcileHrRadarLiveGame(gameId: string): Promise<void> {
    try {
      gradeHomeRunsFromPlays(gameId);
    } catch (err: any) {
      console.warn(`[HR_RADAR_RECONCILE_GAME] gameId=${gameId} grader threw: ${err.message}`);
    }
  }

  /**
   * HR Radar Final-Game Reconciliation — once-only wrapper called from the
   * `live → final` transition gate in `_pollGameInner`. Wraps the existing
   * idempotent storage reconcilers so the final transition has a single
   * authoritative entry point with diagnostic counts.
   *
   * Returns counts the caller / log can surface. NEVER throws — failures
   * are swallowed and surfaced via the warn log in the caller's catch.
   *
   * Phase 4 — real implementation. Builds the per-game `playerHrMap` from the
   * box score, awaits both storage reconcilers, then queries the
   * `hr_radar_alerts` table to derive post-reconciliation counts.
   * `activeRemainingAfterFinal` should be 0 after a healthy reconcile;
   * non-zero values surface the exact slip the spec is hardening against.
   */
  async reconcileHrRadarFinalGame(
    gameId: string,
    sessionDate: string,
  ): Promise<{
    gameId: string;
    resolvedHits: number;
    resolvedMisses: number;
    uncalledHrs: number;
    expiredInactive: number;
    activeRemainingAfterFinal: number;
  }> {
    const counts = {
      gameId,
      resolvedHits: 0,
      resolvedMisses: 0,
      uncalledHrs: 0,
      expiredInactive: 0,
      activeRemainingAfterFinal: 0,
    };

    try {
      // Build playerHrMap from the box score (mirrors the per-poll block
      // below at L1201). Falls back to an empty map when the box score has
      // not been hydrated yet — the per-poll path will retry on the next
      // 10s cycle and self-heal.
      const boxScore = mlbGameCache.gameBoxScore?.[gameId];
      const newState = mlbGameCache.gameState[gameId];
      const playerHrMap = new Map<string, { inning: number; half: string }>();
      if (boxScore?.byPlayerId) {
        for (const [pid, bsp] of Object.entries(boxScore.byPlayerId)) {
          const hrCount = (bsp as any).hr ?? 0;
          if (hrCount > 0) {
            const lastInning = newState?.inning ?? 9;
            playerHrMap.set(pid, { inning: lastInning, half: "final" });
          }
        }
      }

      // The legacy `reconcileAlertsForGame` updates the persistedAlerts
      // table and is independent of `playerHrMap`, so it always runs.
      await storage.reconcileAlertsForGame(gameId).catch(() => 0);

      // Hydration guard — `reconcileHrRadarAlertsForGame` mass-marks any
      // remaining `status='live'` HR radar alerts as `called_miss` for
      // every player NOT in `playerHrMap`. If the box score has not yet
      // hydrated, that map is empty (or short), so true HR rows would be
      // permanently mis-graded (subsequent calls only operate on
      // `status='live'` rows, never reversing the miss).
      //
      // Strategy: only run the radar-table reconcile inside this once-only
      // wrapper when the box score is clearly hydrated (has byPlayerId).
      // If it is not hydrated, defer to the per-poll reconciler at
      // `_pollGameInner` (~L1217), which keeps running every 10s while the
      // game stays final and will self-heal once the box score arrives.
      const boxHydrated = !!(boxScore?.byPlayerId && Object.keys(boxScore.byPlayerId).length > 0);
      if (boxHydrated) {
        await storage.reconcileHrRadarAlertsForGame(gameId, playerHrMap).catch(() => undefined);
      } else {
        console.log(`[HR_RADAR_FINAL_RECONCILE] gameId=${gameId} sessionDate=${sessionDate} deferred=hr_radar_table reason=box_score_not_hydrated (per-poll reconciler will retry every 10s)`);
      }

      // Derive counts from the post-reconcile table state.
      const rows = await storage.getTodayHrRadarBoardForSession(sessionDate).catch(() => [] as any[]);
      const gameRows = (rows as any[]).filter((r) => r.gameId === gameId);
      const calledHitStatuses = new Set([
        "called_hit", "called_hit_attack", "called_hit_ready", "called_hit_build", "called_hit_watch",
      ]);
      for (const r of gameRows) {
        const gs = String(r.gradingStatus ?? "").toLowerCase();
        const st = String(r.status ?? "").toLowerCase();
        if (calledHitStatuses.has(gs)) counts.resolvedHits++;
        else if (gs === "called_miss" || st === "miss") counts.resolvedMisses++;
        else if (gs === "uncalled_hr") counts.uncalledHrs++;
        else if (gs === "late_signal" || gs === "early_hr_insufficient_sample") counts.expiredInactive++;
        if (st === "live") counts.activeRemainingAfterFinal++;
      }
    } catch (err: any) {
      console.warn(`[HR_RADAR_FINAL_RECONCILE] gameId=${gameId} count derivation failed: ${err?.message ?? err}`);
    }

    console.log(`[HR_RADAR_FINAL_RECONCILE] gameId=${gameId} sessionDate=${sessionDate} resolvedHits=${counts.resolvedHits} resolvedMisses=${counts.resolvedMisses} uncalledHrs=${counts.uncalledHrs} expiredInactive=${counts.expiredInactive} activeRemainingAfterFinal=${counts.activeRemainingAfterFinal}`);
    return counts;
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    console.log("[MLB orchestrator] Stopped");
  }

  async pollGames(): Promise<void> {
    try {
      const discovered = await discoverTodaysGames();
      const discoveredIds = new Set(discovered.map((g) => g.gameId));

      // Defense-in-depth: even if a future change makes discoverTodaysGames
      // swallow errors and return [] again, refuse to wipe the registry when
      // discovery comes back empty but we still have registered games WHOSE
      // startTime is from today (ET). Stale registrations from a prior session
      // date (e.g. the process survived across a true off-day) MUST still be
      // pruned, otherwise yesterday's games would poll forever.
      const previouslyRegistered = getActiveGames();
      if (discovered.length === 0 && previouslyRegistered.length > 0) {
        const today = todayET();
        const todaysRegistered = previouslyRegistered.filter((g) => {
          if (!g.startTime) return false;
          const gameET = dateToET(new Date(g.startTime));
          return gameET === today;
        });
        if (todaysRegistered.length > 0) {
          console.warn(
            `[MLB orchestrator] pollGames: discovery returned 0 games but ${todaysRegistered.length}/${previouslyRegistered.length} registered are from today (${today}) — treating as transient failure, skipping prune.`
          );
          return;
        }
      }

      // Register new games + pre-hydrate pitcher stats and weather
      for (const game of discovered) {
        const isNew = !getGame(game.gameId);
        registerGame(game);
        if (isNew && game.gamePk) {
          this.preHydrateNewGame(game).catch(console.error);
          // For freshly-discovered games that may already be live, kick off
          // an immediate state poll so the cached inning/score is accurate
          // within ~1s instead of waiting for the next 10s tick (which would
          // leave the UI showing the default "top of 1st" placeholder).
          this.pollGame(game.gameId).catch((err) =>
            console.warn(`[MLB orchestrator] immediate poll failed for ${game.gameId}:`, err.message)
          );
        }
      }

      // Remove games no longer active — snapshot stats before removal
      for (const existing of getActiveGames()) {
        if (!discoveredIds.has(existing.gameId)) {
          this.snapshotGamePlayerStats(existing.gameId, existing.gamePk).catch(err =>
            console.warn(`[MLB orchestrator] snapshot failed for ${existing.gameId}:`, err.message)
          );
          removeGame(existing.gameId);
          this.previousStates.delete(existing.gameId);
          clearScheduler("mlb", existing.gameId);
          clearTier("mlb", existing.gameId);
          // HR Radar Final-Game Reconciliation — release the once-only
          // transition gate so a same-day re-discovery (rare, but possible
          // after a midnight rollover or test reset) re-fires the
          // [HR_RADAR_GAME_FINAL_DETECTED] branch.
          MLB_FINAL_LOGGED.delete(existing.gameId);
        }
      }
    } catch (err: any) {
      console.error("[MLB orchestrator] pollGames error:", err.message);
    }
  }

  private async snapshotGamePlayerStats(gameId: string, gamePk?: string): Promise<void> {
    const { storage } = await import("../storage");
    if (!gamePk) {
      console.log(`[MLB snapshot] No gamePk for ${gameId}, skipping snapshot`);
      return;
    }
    try {
      const url = `https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`;
      const response = await fetch(url, {
        headers: { "User-Agent": "LiveLocks/1.0" },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`MLB boxscore API ${response.status}`);
      const data = (await response.json()) as any;
      const gameDate = todayET();
      const stats: Array<any> = [];

      for (const side of ["away", "home"] as const) {
        const teamData = data.teams?.[side];
        if (!teamData) continue;
        const batters: number[] = teamData.batters ?? [];
        const playerMap = teamData.players ?? {};
        const teamAbbr = teamData.team?.abbreviation ?? "";
        for (const batterId of batters) {
          const entry = playerMap[`ID${batterId}`];
          if (!entry) continue;
          const batting = entry.stats?.batting ?? {};
          const slotRaw: string = entry.battingOrder ?? "0";
          const slot = Math.floor(parseInt(slotRaw, 10) / 100) || 0;
          const contactEntry = mlbGameCache.contactData[gameId]?.byPlayerId?.[String(batterId)];
          const priorABResults = contactEntry?.priorABResults ?? [];
          stats.push({
            gameId,
            gamePk,
            playerId: String(batterId),
            playerName: entry.person?.fullName ?? "",
            teamAbbr,
            teamSide: side,
            battingOrderSlot: slot,
            ab: batting.atBats ?? 0,
            h: batting.hits ?? 0,
            tb: batting.totalBases ?? 0,
            r: batting.runs ?? 0,
            rbi: batting.rbi ?? 0,
            bb: batting.baseOnBalls ?? 0,
            k: batting.strikeOuts ?? 0,
            sb: batting.stolenBases ?? 0,
            abResults: priorABResults.length > 0 ? JSON.stringify(priorABResults) : null,
            gameDate,
          });
        }
      }
      await storage.persistGamePlayerStats(stats);
      console.log(`[MLB snapshot] Persisted ${stats.length} players for game ${gameId}`);
    } catch (err: any) {
      console.error(`[MLB snapshot] Failed for game ${gameId}:`, err.message);
    }
  }

  private async preHydrateNewGame(game: import("./gameDiscoveryService").MLBGame): Promise<void> {
    const { gameId, gamePk } = game;
    if (!gamePk) return;
    console.log(`[MLB_PREHYDRATE] Starting pre-hydration for game ${gameId} (gamePk=${gamePk})`);

    const phase1: Promise<void>[] = [];

    phase1.push(
      syncGameState(gamePk, gameId).then(async () => {
        const state = mlbGameCache.gameState[gameId];
        if (!state) return;

        if (state.pitcherInGame?.playerId) {
          await syncPitcherSeasonStats(state.pitcherInGame.playerId);
          const stats = mlbPlayerCache.pitcherSeasonStats[state.pitcherInGame.playerId];
          console.log(`[MLB_PREHYDRATE] Pitcher ${state.pitcherInGame.playerName}: ERA=${stats?.era ?? "?"} WHIP=${stats?.whip ?? "?"}`);
        }
      })
    );

    phase1.push(
      syncWeather(gamePk, gameId).then(async () => {
        const weather = mlbGameCache.weather[gameId];
        if (weather?.venueName) {
          await syncOpenMeteoWeather(gameId, weather.venueName);
        }
      })
    );

    await Promise.allSettled(phase1);
    console.log(`[MLB_PREHYDRATE] Completed pre-hydration for game ${gameId}`);
  }

  private buildMlbContext(gameId: string): MlbGameContext {
    const game = getGame(gameId);
    const state = mlbGameCache.gameState[gameId];
    const status = normalizeMlbStatus(game?.espnStatus);
    let inning: number | undefined;
    let isTopInning: boolean | undefined;
    if (state) {
      inning = state.inning;
      isTopInning = state.isTopInning;
    }
    let startsInMinutes: number | undefined;
    if (game?.startTime) {
      const startMs = new Date(game.startTime).getTime();
      if (!isNaN(startMs)) startsInMinutes = Math.max(0, (startMs - Date.now()) / 60000);
    }
    const cachedEdge = mlbEdgeCache.get(gameId);
    const hasActiveSignals = (cachedEdge?.qualifiedSignals?.length ?? 0) > 0;
    return {
      gameId,
      status: status === "live" || status === "pregame" || status === "final" ? status : "unknown",
      inning,
      isTopInning,
      hasActiveSignals,
      startsInMinutes,
    };
  }

  async pollGame(gameId: string): Promise<void> {
    if (this.pollInFlight.has(gameId)) return;
    this.pollInFlight.add(gameId);
    try {
      await this._pollGameInner(gameId);
    } finally {
      this.pollInFlight.delete(gameId);
    }
  }

  private async _pollGameInner(gameId: string): Promise<void> {
    const prevState = this.previousStates.get(gameId);

    const registeredGame = getGame(gameId);
    const statsPk: string | undefined = registeredGame?.gamePk;

    if (!statsPk) {
      console.log(`[MLB orchestrator] pollGame(${gameId}): gamePk not yet resolved — skipping Stats API calls`);
      return;
    }

    // Task #121 Step 1 — hydrate HR alert detection state from DB on first
    // poll after a process boot. Without this, the in-memory stateMap is
    // empty after restart and the first non-WATCH transition re-stamps
    // detection at the current inning, making every card on screen show
    // "Detected" at the boot inning.
    if (!HR_RADAR_HYDRATED_GAMES.has(gameId)) {
      try {
        const rows = await storage.getHrRadarDetectionsForGame(gameId);
        for (const r of rows) {
          if (r.detectedInning == null || r.detectedAt == null) continue;
          const halfNorm = (r.detectedHalf ?? "").toLowerCase();
          const half: "top" | "bottom" | null =
            halfNorm.startsWith("t") ? "top" : halfNorm.startsWith("b") ? "bottom" : null;
          seedHrAlertDetection(gameId, r.playerId, r.playerName, {
            detectedInning: r.detectedInning,
            detectedHalf: half,
            detectedAtMs: new Date(r.detectedAt).getTime(),
          });
        }
        // Only mark hydrated AFTER successful seed so a transient DB failure
        // can be retried on the next poll instead of being skipped forever.
        HR_RADAR_HYDRATED_GAMES.add(gameId);
        if (rows.length > 0) {
          console.log(`[HR_RADAR_HYDRATE] gameId=${gameId} seeded=${rows.length} (restart-safe detection persistence)`);
        }
      } catch (err: any) {
        console.warn(`[HR_RADAR_HYDRATE] failed for game ${gameId}: ${err.message} — will retry next poll`);
      }
    }

    await syncGameState(statsPk, gameId);
    await syncGameBoxScore(statsPk, gameId);
    const contactChanges = await syncContactData(statsPk, gameId);
    await syncPitcherContext(statsPk, gameId);

    // Resolve normalized status EARLY so HR-radar gates can use it. Previously
    // these gates read mlbGameCache.gameState[gameId].status (raw MLB Stats API
    // field), which is frequently empty until ESPN fallback runs further down,
    // causing the HR radar to never evaluate any batter and the ledger to stay
    // empty. Computing the normalized status here unlocks the radar pipeline.
    let normalizedStatus: "live" | "pregame" | "final" | "unknown" = "unknown";
    let statusSource = "none";
    try {
      // Phase B diagnosis: previously used /api/v1/game/{pk}/feed/live which
      // MLB Stats API now returns HTTP 404 for ("Not Found"). The correct
      // schema is v1.1 (used by dataPullService and rosterService). Because
      // the prior code only logged on thrown errors (not on !res.ok), every
      // status fetch silently failed → normalizedStatus stayed "unknown" →
      // triggerEngine was NEVER called for any game → entire signal pipeline
      // was dormant. ESPN fallback below also never fired for games whose
      // espnStatus wasn't pre-populated, so the engine remained dark.
      const statusUrl = `https://statsapi.mlb.com/api/v1.1/game/${statsPk}/feed/live`;
      const statusRes = await fetch(statusUrl, {
        headers: { "User-Agent": "LiveLocks/1.0" },
        signal: AbortSignal.timeout(4000),
      });
      if (statusRes.ok) {
        const statusData = (await statusRes.json()) as any;
        const rawAbstractState: string = statusData.gameData?.status?.abstractGameState ?? "";
        normalizedStatus = normalizeMlbStatus(rawAbstractState);
        if (normalizedStatus !== "unknown") statusSource = "mlbStatsApi";
      } else {
        console.warn(`[MLB orchestrator] pollGame: MLB Stats API status HTTP ${statusRes.status} for game ${gameId} (gamePk=${statsPk}) — falling back to ESPN/time`);
      }
    } catch (err: any) {
      console.warn(`[MLB orchestrator] pollGame: MLB Stats API status fetch failed for game ${gameId}: ${err?.message ?? err}`);
    }

    if (normalizedStatus === "unknown" && registeredGame) {
      const espnRaw = registeredGame.espnStatus ?? "";
      if (espnRaw === "STATUS_IN_PROGRESS" || espnRaw === "STATUS_DELAYED") {
        normalizedStatus = "live";
        statusSource = "espnFallback";
      } else if (espnRaw === "STATUS_FINAL" || espnRaw === "STATUS_FORFEIT") {
        normalizedStatus = "final";
        statusSource = "espnFallback";
      } else if (registeredGame.startTime) {
        const startMs = new Date(registeredGame.startTime).getTime();
        if (startMs > 0 && Date.now() >= startMs) {
          normalizedStatus = "live";
          statusSource = "timeFallback";
        }
      }
      if (statusSource !== "none") {
        console.log(`[MLB orchestrator] Status fallback for game ${gameId}: ${normalizedStatus} (source=${statusSource}, espnStatus=${espnRaw})`);
      }
    }

    const isLiveForContact = normalizedStatus === "live";

    // Razor-sharp HR grading: pulls inning attribution from each HR play directly,
    // not from the orchestrator's current state.inning (which can roll over).
    // Runs every poll cycle (live + final) so post-game catch-ups still resolve correctly.
    gradeHomeRunsFromPlays(gameId);

    if (contactChanges.length > 0 && isLiveForContact) {
      await this.reevaluateHRRadarOnContact(gameId, contactChanges);
    }

    if (isLiveForContact) {
      await this.periodicHRRadarRosterScan(gameId);
    }

    const stateAfterSync = mlbGameCache.gameState[gameId];
    if (stateAfterSync) {
      const playerSyncPromises: Promise<void>[] = [];
      let bvpCount = 0;
      let rollingCount = 0;
      let batterCount = 0;

      if (stateAfterSync.pitcherInGame?.playerId) {
        playerSyncPromises.push(
          syncPitcherSeasonStats(stateAfterSync.pitcherInGame.playerId).then(() => {
            const stats = mlbPlayerCache.pitcherSeasonStats[stateAfterSync.pitcherInGame!.playerId];
            if (stats) {
              console.log(`[MLB_PITCHER_HYDRATE] game=${gameId} pitcher=${stateAfterSync.pitcherInGame!.playerName ?? stateAfterSync.pitcherInGame!.playerId} ERA=${stats.era ?? "?"} WHIP=${stats.whip ?? "?"} K9=${stats.kPer9 ?? "?"}`);
            }
          })
        );
      }

      for (const batter of stateAfterSync.battingOrder) {
        if (batter.playerId && batter.playerId !== "unknown") {
          batterCount++;
          playerSyncPromises.push(
            syncBatterRollingStats(batter.playerId).then(() => {
              if (mlbPlayerCache.batterRollingStats[batter.playerId]) rollingCount++;
            })
          );
          if (stateAfterSync.pitcherInGame?.playerId) {
            const bvpKey = `${batter.playerId}_vs_${stateAfterSync.pitcherInGame.playerId}`;
            playerSyncPromises.push(
              syncBvPMatchup(batter.playerId, stateAfterSync.pitcherInGame.playerId).then(() => {
                if (mlbPlayerCache.bvpMatchups[bvpKey]) bvpCount++;
              })
            );
          }
        }
      }

      playerSyncPromises.push(syncSavantSeasonForLineup(gameId));

      await Promise.allSettled(playerSyncPromises);
      if (batterCount > 0) {
        console.log(`[MLB_BVP_HYDRATE] game=${gameId} batters=${batterCount} withBvP=${bvpCount} withRolling=${rollingCount}`);
      }
    }

    const newState = mlbGameCache.gameState[gameId];
    if (!newState) return;

    // normalizedStatus + statusSource were already resolved earlier (above the
    // HR-radar gates) so this section just consumes them.
    if (normalizedStatus === "final") {
      // HR Radar Final-Game Reconciliation — Phase 1.
      // Once-per-process transition gate. The body of this if-block runs every
      // 10s while the game stays final; the operations below this gate must
      // fire exactly once: the diagnostic log, the edge-cache flush, and
      // (Phase 4) the reconcileHrRadarFinalGame wrapper. Idempotent inner
      // operations (storage.reconcile*, KNOWN_HR_*.delete, etc.) stay outside
      // the gate so they continue to self-heal on every poll.
      if (!MLB_FINAL_LOGGED.has(gameId)) {
        MLB_FINAL_LOGGED.add(gameId);
        const oldStatusForLog = prevState ? "live_or_pregame" : "unknown";
        console.log(`[HR_RADAR_GAME_FINAL_DETECTED] gameId=${gameId} oldStatus=${oldStatusForLog} newStatus=final sessionDate=${todayET()}`);
        // Cache flush — drop the in-memory edge cache entry so /api/mlb/hr-radar
        // (and every other route that iterates mlbEdgeCache.entries()) stops
        // serving this game's signals as bettable. The reconciliation/grading
        // tables in the DB remain authoritative for cashed/missed display.
        const hadEdgeCache = mlbEdgeCache.has(gameId);
        if (hadEdgeCache) mlbEdgeCache.delete(gameId);
        console.log(`[HR_RADAR_FINAL_CACHE_FLUSH] gameId=${gameId} edgeCacheCleared=${hadEdgeCache}`);

        // ── LiveLocks Batch C — Game-final lifecycle expiration ─────────
        // Expire every CanonicalSignal still tracked for this game so
        // the bus stops surfacing them to UI / alerts / analytics.
        // Terminal-state signals (already cashed/missed) are no-ops.
        try {
          const { getRegistered, expireSignal } =
            await import("../services/liveSignalBus");
          const stillLive = getRegistered({ sport: "mlb", gameId, excludeTerminal: true, freshOnlyWithinMs: 0 });
          for (const s of stillLive) {
            expireSignal(s.signalId, "game-final");
          }
          if (stillLive.length > 0) {
            console.log(`[LL_SIGNAL_EXPIRED] gameId=${gameId} reason=game-final count=${stillLive.length}`);
          }
        } catch (err) {
          console.warn(`[LL_SIGNAL_REJECTED] game-final sweep failed gameId=${gameId} reason=${(err as Error).message}`);
        }
        // Phase 4 — fire the once-only reconciliation wrapper. Defensive
        // try/catch so a reconcile failure never blocks the per-game cleanup
        // below. Detailed counts are logged inside reconcileHrRadarFinalGame.
        this.reconcileHrRadarFinalGame(gameId, todayET()).catch((err) =>
          console.warn(`[HR_RADAR_FINAL_RECONCILE] gameId=${gameId} wrapper threw: ${err?.message ?? err}`)
        );
      }
      const boxScore = mlbGameCache.gameBoxScore?.[gameId];
      const playerHrMap = new Map<string, { inning: number; half: string }>();
      if (boxScore?.byPlayerId) {
        for (const [pid, bsp] of Object.entries(boxScore.byPlayerId)) {
          const hrCount = (bsp as any).hr ?? 0;
          if (hrCount > 0) {
            const liveKey = `${gameId}_${pid}`;
            const alreadyGraded = KNOWN_HR_COUNTS.has(liveKey);
            if (!alreadyGraded) {
              storage.resolveAlertAsHit(pid, gameId, 0, "final", 0).catch(() => {});
            }
            const lastInning = newState.inning ?? 9;
            playerHrMap.set(pid, { inning: lastInning, half: "final" });
          }
        }
      }
      storage.reconcileAlertsForGame(gameId).catch(() => {});
      storage.reconcileHrRadarAlertsForGame(gameId, playerHrMap).catch(() => {});
      clearGameCooldowns(gameId);
      clearGameHrStates(gameId);
      for (const key of Array.from(KNOWN_HR_COUNTS.keys())) {
        if (key.startsWith(`${gameId}_`)) KNOWN_HR_COUNTS.delete(key);
      }
      for (const key of Array.from(KNOWN_HR_AB_INDEX.keys())) {
        if (key.startsWith(`${gameId}_`)) KNOWN_HR_AB_INDEX.delete(key);
      }
      // HR Radar audit fix #1 — release per-game resolved-HR set at game-final.
      for (const key of Array.from(RESOLVED_HR_PLAYERS)) {
        if (key.startsWith(`${gameId}_`)) RESOLVED_HR_PLAYERS.delete(key);
      }
      // HR Radar Lifecycle Repair Fix #2 — release per-game outcome stamps
      // at game-final so a same-day re-run starts clean.
      try {
        const dropped = hrRadarOutcomeStampMod.clearHrRadarOutcomeStampsForGame(gameId);
        if (dropped > 0) {
          console.log(`[HR_RADAR_INACTIVE] gameId=${gameId} cleared HR Radar outcome stamps count=${dropped} reason=game_final`);
        }
      } catch { /* best effort */ }
      // HR Radar Lifecycle Repair — release per-game user-stage memory at
      // game-final so transition diagnostics for the next session don't
      // compare against stale prior-game state.
      try {
        const droppedStages = hrRadarUserStageMod.clearUserStageMemoryForGame(gameId);
        if (droppedStages > 0) {
          console.log(`[HR_RADAR_INACTIVE] gameId=${gameId} cleared HR Radar user-stage memory count=${droppedStages} reason=game_final`);
        }
      } catch { /* best effort */ }
      // MLB Signals audit P1 — release per-game resolved non-HR markets.
      for (const key of Array.from(RESOLVED_NON_HR_MARKETS)) {
        if (key.startsWith(`${gameId}_`)) RESOLVED_NON_HR_MARKETS.delete(key);
      }
      // MLB Signals audit P2 — release per-game non-HR engine state entries.
      clearNonHrStatesForGame(gameId);
    }

    if (prevState) {
      const triggers = this.detectStateChange(prevState, newState);
      if (triggers.length > 0) {
        console.log(`[MLB orchestrator] State change for game ${gameId} (status=${normalizedStatus}, source=${statusSource}): ${triggers.join(", ")}`);

        if (triggers.includes("inning_change")) {
          await syncBullpenUsage(statsPk, gameId);
        }

        await this.triggerEngine(gameId, normalizedStatus, triggers);
      } else if (normalizedStatus === "live") {
        // Freshness Integrity Fix #1 — never fake-refresh the cache timestamp.
        // If no real state-change trigger fired, decide whether to fire a real
        // heartbeat recompute based on engine output age. The 15s dedup window
        // inside triggerEngine still protects us from runaway runs.
        const cached = mlbEdgeCache.get(gameId);
        const lastEngineRunAt = Math.max(cached?.updatedAt ?? 0, cached?.createdAt ?? 0);
        const ageMs = lastEngineRunAt > 0 ? Date.now() - lastEngineRunAt : Infinity;
        // MLB Signals audit P5 — 45s -> 25s. The user-facing edge feed now
        // expects sub-30s freshness; heartbeat must keep pace so cards
        // don't flat-line during natural between-PA gaps.
        if (ageMs > 25_000) {
          console.log(`[MLB HEARTBEAT_RECOMPUTE] game=${gameId} ageMs=${ageMs === Infinity ? "inf" : ageMs}`);
          await this.triggerEngine(gameId, normalizedStatus, ["heartbeat_refresh"]);
        }
      }
    } else if (normalizedStatus === "live") {
      console.log(`[MLB orchestrator] First poll for live game ${gameId} (status=${normalizedStatus}, source=${statusSource}) — triggering engine`);
      await this.triggerEngine(gameId, normalizedStatus);
    }

    this.previousStates.set(gameId, { ...newState });
  }

  detectStateChange(
    oldState: GameStateCache,
    newState: GameStateCache
  ): StateChangeTrigger[] {
    const triggers: StateChangeTrigger[] = [];

    if (oldState.inning !== newState.inning || oldState.isTopInning !== newState.isTopInning) {
      triggers.push("inning_change");
    }

    if (oldState.currentBatter?.playerId !== newState.currentBatter?.playerId) {
      triggers.push("new_ab");
    }

    if (oldState.pitcherInGame?.playerId !== newState.pitcherInGame?.playerId) {
      triggers.push("pitcher_change");
    }

    const oldRunners = JSON.stringify((oldState.runnersOnBase ?? []).sort());
    const newRunners = JSON.stringify((newState.runnersOnBase ?? []).sort());
    if (oldRunners !== newRunners) {
      triggers.push("runner_change");
    }

    if (newState.pitchCount > oldState.pitchCount) {
      triggers.push("ball_in_play");
    }

    if (newState.outs !== oldState.outs) {
      triggers.push("out_recorded");
    }

    const oldTotal = oldState.totalPlays ?? 0;
    const newTotal = newState.totalPlays ?? 0;
    if (newTotal > oldTotal) {
      triggers.push("ab_completed");
    }

    const oldHomeScore = oldState.homeScore ?? 0;
    const oldAwayScore = oldState.awayScore ?? 0;
    const newHomeScore = newState.homeScore ?? 0;
    const newAwayScore = newState.awayScore ?? 0;
    if (newHomeScore !== oldHomeScore || newAwayScore !== oldAwayScore) {
      triggers.push("score_change");
    }

    const pitchCountThresholds = [50, 65, 75, 85, 95, 105];
    for (const threshold of pitchCountThresholds) {
      if (oldState.pitchCount < threshold && newState.pitchCount >= threshold) {
        triggers.push("pitch_count_threshold");
        break;
      }
    }

    const oldTTO = (oldState as any).timesThrough ?? 1;
    const newTTO = (newState as any).timesThrough ?? 1;
    if (newTTO > oldTTO) {
      triggers.push("tto_shift");
    }

    const oldBatterCount = (oldState as any).battingOrder?.length ?? 0;
    const newBatterCount = (newState as any).battingOrder?.length ?? 0;
    if (newBatterCount !== oldBatterCount && oldBatterCount > 0) {
      triggers.push("lineup_substitution");
    }

    return triggers;
  }

  private computeImpactedMarkets(triggers: StateChangeTrigger[]): Set<MLBMarket> {
    const impacted = new Set<MLBMarket>();
    for (const t of triggers) {
      const markets = TRIGGER_IMPACTED_MARKETS[t];
      if (markets === "all") {
        return new Set(ALL_MLB_MARKETS);
      }
      for (const m of markets) impacted.add(m);
    }
    return impacted;
  }

  private getDedupWindow(triggers: StateChangeTrigger[]): number {
    // MLB Signals audit P5 — inning_change forces a fresh recompute even if
    // another trigger (new_ab, ab_completed, etc.) just fired. Inning
    // boundaries change PA-remaining for every batter in the lineup; the
    // engine must run the full feature set against the new inning context.
    if (triggers.includes("inning_change")) return 0;
    const hasHighImpact = triggers.some(t => HIGH_IMPACT_TRIGGERS.has(t));
    return hasHighImpact ? 5_000 : DEDUP_WINDOW_MS;
  }

  private static readonly JARGON_MAP: Record<string, string> = {
    "1xTTO": "First look at lineup",
    "tto_1": "First look at lineup",
    "2xTTO": "Second time through order",
    "tto_2": "Second time through order",
    "3xTTO": "Third time through — elevated risk",
    "tto_3": "Third time through — elevated risk",
    "NO_EDGE": "No actionable signal",
  };

  private static readonly JARGON_REMOVE = new Set(["EXPERIMENTAL", "SUPPRESSED"]);

  private sanitizeUserFacingFields(signal: MLBQualifiedSignal): void {
    const clean = (arr: string[]): string[] =>
      arr
        .filter(s => !LiveGameOrchestrator.JARGON_REMOVE.has(s))
        .map(s => LiveGameOrchestrator.JARGON_MAP[s] ?? s);

    signal.reasons = clean(signal.reasons);
    signal.badges = clean(signal.badges);
    signal.signalTags = clean(signal.signalTags);
    signal.feedTags = clean(signal.feedTags);
    signal.riskFlags = clean(signal.riskFlags);
  }

  private qualifySignal(gameId: string, input: MLBPropInput, output: MLBPropOutput): MLBQualifiedSignal | null {
    if (output.recommendedSide !== "OVER" && output.recommendedSide !== "UNDER") {
      console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — invalid side="${output.recommendedSide}"`);
      auditRecordRejection(gameId, "marketValidation", output.market, "invalid_side");
      return null;
    }

    if (typeof output.bookLine !== "number" || !Number.isFinite(output.bookLine) || output.bookLine <= 0) {
      console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — invalid bookLine=${output.bookLine}`);
      auditRecordRejection(gameId, "marketValidation", output.market, "invalid_bookLine");
      return null;
    }
    if (typeof output.calibratedProbabilityOver !== "number" || !Number.isFinite(output.calibratedProbabilityOver) || output.calibratedProbabilityOver <= 0) {
      console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — invalid probOver=${output.calibratedProbabilityOver}`);
      auditRecordRejection(gameId, "probability", output.market, "invalid_probOver");
      return null;
    }
    if (typeof output.calibratedProbabilityUnder !== "number" || !Number.isFinite(output.calibratedProbabilityUnder) || output.calibratedProbabilityUnder <= 0) {
      console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — invalid probUnder=${output.calibratedProbabilityUnder}`);
      auditRecordRejection(gameId, "probability", output.market, "invalid_probUnder");
      return null;
    }

    if (output.suppressed) {
      console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — suppressed`);
      auditRecordRejection(gameId, "suppression", output.market, "engine_output_suppressed");
      return null;
    }

    const marketFamily = getMarketFamily(output.market, output.recommendedSide);
    const isBatterOver = marketFamily === "batter_over";

    const sideProbability = getCanonicalSidedProbability(output);

    // Plan D + E: pitcher-quality-aware floor for batter HR/hrr, and pitcher
    // near-miss band (58 ≤ prob < market floor). Both lower the qualification
    // floor under specific conditions and tag the surviving signal as an early
    // / watchlist entry so the UI can route it into the Pre-AB Watch band
    // rather than the main feed. NO scoring/calibration math is touched.
    let bypassedAsEarly = false;
    let earlyBypassTag: "HR_VS_ELITE_PITCHER" | "PITCHER_NEAR_MISS" | null = null;

    if (isBatterOver) {
      let absFloor = 40;
      const isHrFamily = output.market === "hrr" || output.market === "home_runs";
      if (isHrFamily) {
        const pitcherEra = (input as any)?.pitcher?.era ?? null;
        const pitcherK9 = (input as any)?.pitcher?.kPer9 ?? null;
        if (
          pitcherEra != null && Number.isFinite(pitcherEra) && pitcherEra < 2.5 &&
          pitcherK9 != null && Number.isFinite(pitcherK9) && pitcherK9 > 10
        ) {
          absFloor = 32;
          if (sideProbability < 40 && sideProbability >= 32) {
            bypassedAsEarly = true;
            earlyBypassTag = "HR_VS_ELITE_PITCHER";
            console.log(`[MLB QUALIFY HR_VS_ELITE_PITCHER][${gameId}] ${output.playerName}/${output.market} — prob=${sideProbability.toFixed(1)} relaxed to 32 floor (pitcher ERA=${pitcherEra.toFixed(2)} K9=${pitcherK9.toFixed(1)})`);
          }
        }
      }
      if (sideProbability < absFloor) {
        console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — prob=${sideProbability.toFixed(1)} < ${absFloor} absolute floor (batter_over)`);
        auditRecordRejection(gameId, "probability", output.market, `prob_below_batter_over_floor:${absFloor}`, { probability: sideProbability });
        return null;
      }
    } else {
      const qualifyFloor = MARKET_QUALIFY_FLOOR[output.market] ?? 60;
      if (sideProbability < qualifyFloor) {
        const PITCHER_NEAR_MISS_FLOOR = 58;
        const isPitcherProp = ["pitcher_strikeouts", "pitcher_outs", "hits_allowed", "walks_allowed", "hr_allowed", "batter_strikeouts"].includes(output.market);
        if (isPitcherProp && sideProbability >= PITCHER_NEAR_MISS_FLOOR) {
          bypassedAsEarly = true;
          earlyBypassTag = "PITCHER_NEAR_MISS";
          console.log(`[MLB QUALIFY PITCHER_NEAR_MISS][${gameId}] ${output.playerName}/${output.market} — prob=${sideProbability.toFixed(1)} in [${PITCHER_NEAR_MISS_FLOOR}, ${qualifyFloor}) — routing to Pre-AB Watch`);
        } else {
          console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — prob=${sideProbability.toFixed(1)} < ${qualifyFloor} gate`);
          auditRecordRejection(gameId, "probability", output.market, `prob_below_market_floor:${qualifyFloor}`, { probability: sideProbability });
          return null;
        }
      }
    }

    const hydrationOk = canShowSignal({
      line: output.bookLine,
      odds: (output.overOdds !== null || output.underOdds !== null)
        ? { overOdds: output.overOdds, underOdds: output.underOdds }
        : null,
      projection: output.projection,
      oddsUpdatedAt: output.oddsUpdatedAt,
      projectionUpdatedAt: output.projectionUpdatedAt,
      calibratedProbabilityOver: output.calibratedProbabilityOver,
      calibratedProbabilityUnder: output.calibratedProbabilityUnder,
    });
    if (!hydrationOk) {
      console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — hydration gate failed`);
      auditRecordRejection(gameId, "staleOdds", output.market, "hydration_gate_failed");
      return null;
    }

    if (((output.market as string) === "hr" || output.market === "home_runs") && output.recommendedSide === "UNDER") {
      console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — HR UNDER suppressed (unplayable odds)`);
      auditRecordRejection(gameId, "suppression", output.market, "hr_under_unplayable");
      return null;
    }

    if (isBatterOver) {
      const tolerance = ({ hits: 0.08, total_bases: 0.15, home_runs: 0.05, hrr: 0.15, batter_strikeouts: 0.10 } as Record<string, number>)[output.market] ?? 0.10;
      if (output.recommendedSide === "OVER" && output.projection < output.bookLine - tolerance) {
        console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — side inconsistency: OVER but proj=${output.projection} < line=${output.bookLine} - ${tolerance} tolerance (batter_over)`);
        auditRecordRejection(gameId, "marketValidation", output.market, "side_inconsistency_over_batter");
        return null;
      }
    } else {
      if (output.recommendedSide === "OVER" && output.projection < output.bookLine) {
        console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — side inconsistency: OVER but proj=${output.projection} < line=${output.bookLine}`);
        auditRecordRejection(gameId, "marketValidation", output.market, "side_inconsistency_over");
        return null;
      }
    }
    if (output.recommendedSide === "UNDER" && output.projection > output.bookLine) {
      console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — side inconsistency: UNDER but proj=${output.projection} > line=${output.bookLine}`);
      auditRecordRejection(gameId, "marketValidation", output.market, "side_inconsistency_under");
      return null;
    }

    const scoreBreakdown = computeSignalScoreByFamily(input, output);

    let hrRadarResult: ReturnType<typeof scoreHRRadar> | null = null;
    if (output.market === "home_runs") {
      hrRadarResult = scoreHRRadar(input, output);
    }

    // [MLB Phase 2.5] Engine-owned HR Watch detection on the player's last AB.
    // Pure detector — no probability touch. When triggered, we (a) lower the
    // home_runs hr_watch gate from 35→25 player-specific so the signal can
    // actually surface, (b) inject near-HR drivers into signalTags, and (c)
    // stamp signalType:"hr_watch" downstream. We deliberately use the SAME
    // input.contactQuality.priorABResults that the rest of the engine already
    // sees — no cross-tick cache, no parallel data path.
    // Phase 2.5 fix (May 2026) — scan the last 5 ABs and take the
    // strongest near-HR tier seen, instead of only the most recent AB.
    // Real-world miss: Brandon Valenzuela (TOR @ HOU, B5) AB#3 was a
    // textbook lean (104.4 EV / 24° / 382 ft / barrel / xBA .830) but
    // AB#4 was a flat 99.6 mph 6° liner. The old "last AB only" path
    // saw AB#4, returned tier=null, the alert peakReadinessScore stayed
    // at 0, and the eventual HR was graded uncalled. Scanning a small
    // recent window preserves peak detection across the next AB.
    const _priorAbsForNearHr: any[] = (input.contactQuality?.priorABResults ?? []);
    const nearHrPeak = detectNearHrContactPeak(
      _priorAbsForNearHr.map((ab: any) => ({
        ev: ab?.exitVelocity ?? null,
        la: ab?.launchAngle ?? null,
        distance: ab?.distance ?? null,
        xba: ab?.xba ?? ab?.perABxBA ?? null,
        // Phase 2 STEP 5 — propagate Statcast barrel flag from dataPullService
        // so the BARREL_OVERRIDE detection path can fire (Ben Rice repair).
        isBarrel: ab?.isBarrel === true,
      })),
      5,
    );
    const nearHrResult: { tier: null | "watch" | "lean"; drivers: string[]; suppressionReason?: string; matchedPath?: string | null; repeatedDanger?: boolean } = {
      tier: nearHrPeak.tier,
      drivers: nearHrPeak.drivers,
      suppressionReason: nearHrPeak.suppressionReason,
      matchedPath: nearHrPeak.matchedPath ?? null,
      repeatedDanger: nearHrPeak.repeatedDanger,
    };
    // Phase 1 STEP 1 — per-AB eval logs and missed-pattern audit. Pure
    // diagnostics — never affects the tier the orchestrator acts on. Logged
    // for HR-eligible (home_runs / hrr) markets only to bound noise; other
    // markets call the detector but don't surface the AB-level forensic.
    if (output.market === "home_runs" || output.market === "hrr") {
      for (const d of nearHrPeak.diagnostics) {
        const eval_payload = {
          gameId,
          playerId: (input as any).playerId ?? null,
          playerName: output.playerName,
          abIndex: d.abIndex,
          ev: d.ev,
          launchAngle: d.la,
          distance: d.distance,
          xba: d.xba,
          isBarrel: d.isBarrel,
          tags: null,
          isHardHit: d.ev != null && d.ev >= 95,
          detectedTier: d.detectedTier,
          matchedPath: d.matchedPath,
          rejectedReason: d.rejectedReason,
        };
        console.log("[MLB_HR_NEAR_CONTACT_EVAL]", JSON.stringify(eval_payload));
        if (d.missedPattern) {
          console.log("[MLB_HR_NEAR_CONTACT_MISSED_PATTERN]", JSON.stringify(eval_payload));
        }
      }

      // ── HR Radar Canonical State Machine — Phase 2 wiring ──────────────
      // Every qualifying evidence event (HIGH_XBA_DANGER, BARREL_OVERRIDE,
      // REPEATED_DANGER, near-HR LEAN/WATCH) immediately upserts the
      // canonical HR Radar state for this player/game so settlement, UI,
      // and analytics all read the same truth. In-memory only for now.
      // Pure observation — never mutates engine math, signalScore, or
      // CanonicalSignal. Rejected transitions log [HR_RADAR_STATE_REJECTED]
      // and leave existing state untouched.
      const matchedPath = nearHrResult.matchedPath ?? null;
      let canonicalEvent: HrRadarLifecycleEvent | null = null;
      if (matchedPath === "REPEATED_DANGER") canonicalEvent = "REPEATED_DANGER";
      else if (matchedPath === "BARREL_OVERRIDE_LEAN" || matchedPath === "BARREL_OVERRIDE" || matchedPath === "HIGH_XBA_DANGER_BARREL") canonicalEvent = "BARREL";
      else if (matchedPath === "HIGH_XBA_DANGER") canonicalEvent = "NEAR_HR";
      else if (nearHrResult.tier === "lean") canonicalEvent = "NEAR_HR";
      else if (nearHrResult.tier === "watch") canonicalEvent = "CONTACT_EVIDENCE";
      if (canonicalEvent && (input as any).playerId != null) {
        try {
          const evidence: Array<Record<string, unknown>> = [];
          if (nearHrPeak.sourceAbIndex != null) {
            const ab = _priorAbsForNearHr[nearHrPeak.sourceAbIndex];
            if (ab) {
              evidence.push({
                abIndex: nearHrPeak.sourceAbIndex,
                ev: ab?.exitVelocity ?? null,
                la: ab?.launchAngle ?? null,
                distance: ab?.distance ?? null,
                xba: ab?.xba ?? ab?.perABxBA ?? null,
                isBarrel: ab?.isBarrel === true,
                outcome: ab?.outcome ?? null,
              });
            }
          }
          upsertCanonicalHrRadarState({
            gameId,
            playerId: (input as any).playerId,
            playerName: output.playerName,
            team: input.team ?? null,
            event: canonicalEvent,
            context: {
              reason: matchedPath ?? `near_hr_${nearHrResult.tier}`,
              inning: input.inning ?? null,
            },
            triggerAbIndex: nearHrPeak.sourceAbIndex ?? null,
            triggerReasons: nearHrResult.drivers,
            triggerTags: nearHrResult.matchedPath ? [nearHrResult.matchedPath] : [],
            contactEvidence: evidence,
          });
        } catch (e) {
          // canonical state is observability-only — never block the
          // existing qualification pipeline if the store throws.
          console.log("[HR_RADAR_CANONICAL_UPSERT_ERROR]", JSON.stringify({
            gameId,
            playerId: (input as any).playerId,
            error: (e as Error)?.message ?? String(e),
          }));
        }
      }
    }
    const _sourceAb: any =
      nearHrPeak.sourceAbIndex != null
        ? _priorAbsForNearHr[nearHrPeak.sourceAbIndex]
        : (_priorAbsForNearHr.slice(-1)[0] ?? null);
    const _lastAbForNearHr: any = _priorAbsForNearHr.slice(-1)[0] ?? null;
    if (nearHrResult.tier) {
      const detRec = {
        player: output.playerName,
        team: input.team ?? null,
        market: output.market,
        inning: input.inning ?? null,
        result: _sourceAb?.outcome ?? null,
        ev: _sourceAb?.exitVelocity ?? null,
        la: _sourceAb?.launchAngle ?? null,
        distance: _sourceAb?.distance ?? null,
        xba: _sourceAb?.xba ?? null,
        signalTier: nearHrResult.tier,
        drivers: nearHrResult.drivers,
        sourceAbIndex: nearHrPeak.sourceAbIndex,
        scannedWindow: Math.min(5, _priorAbsForNearHr.length),
        totalAbs: _priorAbsForNearHr.length,
      };
      console.log("[MLB_HR_WATCH_DETECTED]", detRec);
      import("./diagnosticsBuffer")
        .then((m) => m.recordHrWatchDetection(detRec))
        .catch(() => {});
    } else if (nearHrResult.suppressionReason && nearHrResult.suppressionReason !== "no_at_bat") {
      const supRec = {
        player: output.playerName,
        market: output.market,
        reason: nearHrResult.suppressionReason,
        ev: _lastAbForNearHr?.exitVelocity ?? null,
        la: _lastAbForNearHr?.launchAngle ?? null,
        distance: _lastAbForNearHr?.distance ?? null,
        xba: _lastAbForNearHr?.xba ?? null,
      };
      console.log("[MLB_HR_WATCH_SUPPRESSED]", supRec);
      import("./diagnosticsBuffer")
        .then((m) => m.recordHrWatchSuppressed(supRec))
        .catch(() => {});
    }
    // Player-specific gate lowering: when near-HR contact is confirmed, drop
    // the HR Radar hr_watch threshold from 35 → 25 so the signal can surface.
    // Phase 1.5 caps and qualification side-checks all still bind on top.
    const HR_WATCH_GATE = nearHrResult.tier ? 25 : 35;

    // ROI HARDENING: batter_over markets (hits/total_bases/hrr/home_runs) are
    // the lowest-ROI family. Tighten the floor from 42→46 and add a borderline
    // conviction-cluster gate so single-positive setups stay watch-only and
    // do not promote into surfaced lean/strong plays without a real driver.
    //
    // HIGH_PROB_BYPASS (Apr 2026): when the calibrated side probability is
    // already strong on its own (≥ 65%), do not silently drop the signal just
    // because the in-game signalScore is low (early-inning / pre-AB scores
    // are structurally low because contact / streak inputs are zero). Surface
    // it as a watch-tier "HIGH_PROB" entry instead — all hard floors above
    // (absolute prob floor, hydration, side-consistency, HR-UNDER block) still
    // apply, so this can only rescue setups where the math itself is solid.
    const HIGH_PROB_BYPASS_THRESHOLD = 65;
    const passesHighProb = sideProbability >= HIGH_PROB_BYPASS_THRESHOLD;
    let bypassedByHighProb = false;
    const minScore = isBatterOver ? 46 : 50;
    if (scoreBreakdown.total < minScore) {
      if (hrRadarResult && hrRadarResult.total >= HR_WATCH_GATE) {
        console.log(`[MLB QUALIFY HR_WATCH][${gameId}] ${output.playerName}/${output.market} — batterOverScore=${scoreBreakdown.total} < ${minScore} but hrRadarScore=${hrRadarResult.total} ≥ ${HR_WATCH_GATE} (nearHr=${nearHrResult.tier ?? "none"}), surfacing as HR_WATCH`);
      } else if (passesHighProb) {
        bypassedByHighProb = true;
        console.log(`[MLB QUALIFY HIGH_PROB_BYPASS][${gameId}] ${output.playerName}/${output.market} — signalScore=${scoreBreakdown.total} < ${minScore} but prob=${sideProbability.toFixed(1)} ≥ ${HIGH_PROB_BYPASS_THRESHOLD} — surfacing as HIGH_PROB watch`);
      } else if (bypassedAsEarly) {
        // Plan D/E: HR_VS_ELITE_PITCHER and PITCHER_NEAR_MISS candidates also
        // bypass the score gate — they're explicitly intended to surface as
        // Pre-AB Watch entries, not be silently dropped by score floors.
        console.log(`[MLB QUALIFY EARLY_BYPASS_SCORE][${gameId}] ${output.playerName}/${output.market} — signalScore=${scoreBreakdown.total} < ${minScore} but tag=${earlyBypassTag} — surfacing as Pre-AB Watch`);
      } else {
        console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — signalScore=${scoreBreakdown.total} < ${minScore} gate (tier=${scoreBreakdown.confidenceTier})`);
        auditRecordRejection(gameId, "signalScore", output.market, `signalScore_below_min:${minScore}`, { signalScore: scoreBreakdown.total, probability: sideProbability });
        // SHADOW QUALIFICATION MODE — passive evaluation of the candidate
        // batter_over signalScore floor (43 vs live 46). Shadow signals are
        // recorded for analytics ONLY and NEVER surface to users / alerts /
        // grading / ROI. We only enter shadow eval at this exact reject site
        // because all other live gates above have already passed (probability,
        // side validation, hydration, HR-UNDER block, suppression,
        // HIGH_PROB_BYPASS, EARLY_BYPASS, HR_WATCH).
        if (isBatterOver) {
          try {
            evaluateShadowBatterOver({
              gameId,
              market: output.market,
              playerName: output.playerName,
              playerId: (input as any).playerId ?? null,
              side: output.recommendedSide,
              probability: sideProbability,
              signalScore: scoreBreakdown.total,
              bookLine: output.bookLine ?? null,
              projection: (output as any).projection ?? null,
              edge: output.edge ?? null,
              scoreBreakdown: {
                matchup: scoreBreakdown.matchup,
                liveContext: scoreBreakdown.liveContext,
                form: scoreBreakdown.form,
                total: scoreBreakdown.total,
                confidenceTier: scoreBreakdown.confidenceTier,
              },
            });
          } catch (shadowErr: any) {
            // Shadow path is observation-only — never let it break live qual.
            console.warn(`[LL_SHADOW_EVAL_ERROR] ${shadowErr?.message ?? shadowErr}`);
          }
        }
        return null;
      }
    } else if (
      isBatterOver &&
      scoreBreakdown.total < 55 &&
      ["hits", "total_bases", "hrr", "home_runs"].includes(output.market)
    ) {
      // Borderline batter_over band (46-54): require at least one strong
      // conviction driver (matchup, live confirmation, or recent form).
      // Without a driver, downgrade to HR_WATCH if HR-eligible, else reject.
      // HIGH_PROB_BYPASS also rescues here — a 65%+ probability counts as a
      // conviction driver in its own right.
      const hasConviction =
        scoreBreakdown.matchup >= 55 ||
        scoreBreakdown.liveContext >= 55 ||
        scoreBreakdown.form >= 60;
      if (!hasConviction) {
        if (hrRadarResult && hrRadarResult.total >= HR_WATCH_GATE) {
          console.log(`[MLB QUALIFY HR_WATCH][${gameId}] ${output.playerName}/${output.market} — borderline batter_over score=${scoreBreakdown.total} no conviction cluster (matchup=${scoreBreakdown.matchup} live=${scoreBreakdown.liveContext} form=${scoreBreakdown.form}) gate=${HR_WATCH_GATE} (nearHr=${nearHrResult.tier ?? "none"}), routing to HR_WATCH`);
        } else if (passesHighProb) {
          bypassedByHighProb = true;
          console.log(`[MLB QUALIFY HIGH_PROB_BYPASS][${gameId}] ${output.playerName}/${output.market} — borderline batter_over score=${scoreBreakdown.total} no conviction cluster but prob=${sideProbability.toFixed(1)} ≥ ${HIGH_PROB_BYPASS_THRESHOLD} — surfacing as HIGH_PROB watch`);
        } else {
          console.log(`[MLB QUALIFY REJECT][${gameId}] ${output.playerName}/${output.market} — borderline batter_over score=${scoreBreakdown.total} lacks conviction cluster (matchup=${scoreBreakdown.matchup} live=${scoreBreakdown.liveContext} form=${scoreBreakdown.form})`);
          auditRecordRejection(gameId, "signalScore", output.market, "borderline_no_conviction_cluster", { signalScore: scoreBreakdown.total, probability: sideProbability });
          return null;
        }
      }
    }

    const signalTags = deriveSignalTags(input, output, scoreBreakdown);
    // HR Radar audit fix #4 — pass HR-resolved status so feed-tag derivation
    // can drop the hr_radar / hr_watchlist tags for any player who has
    // already homered this game.
    const isHrResolvedPlayer = output.market === "home_runs" &&
      RESOLVED_HR_PLAYERS.has(`${gameId}_${input.playerId}`);
    const feedTags = deriveFeedTags(input, output, scoreBreakdown, { isHrResolved: isHrResolvedPlayer });
    const glowEligible = isPlayerGlowEligible(scoreBreakdown, signalTags);
    const pitcherSigs = derivePitcherSignals(input, output);
    const opportunityScore = computeFullOpportunityScore(input, input.inning);
    const liveScore = computeLiveOpportunityScore(scoreBreakdown.total, output.edge, opportunityScore, marketFamily ?? undefined);

    let adjustedProjection = output.projection;
    const isPitcherMarket = ["pitcher_strikeouts", "pitcher_outs", "hits_allowed"].includes(output.market);
    if (isPitcherMarket && pitcherSigs.length > 0) {
      let sigBoost = 0;
      for (const ps of pitcherSigs) {
        if (ps === "DOMINANT") sigBoost += 0.08;
        else if (ps === "K_STREAK") sigBoost += 0.06;
        else if (ps === "COMMAND_LOCKED") sigBoost += 0.04;
        else if (ps === "FATIGUE_RISK") sigBoost -= 0.05;
        else if (ps === "VELOCITY_DROP") sigBoost -= 0.04;
        else if (ps === "HARD_CONTACT") sigBoost -= 0.06;
      }
      adjustedProjection = output.projection + output.projection * sigBoost;
      if (sigBoost !== 0) {
        console.log(`[SIGNAL_PROJ_LINK] ${output.playerName}/${output.market} projection ${output.projection.toFixed(2)}→${adjustedProjection.toFixed(2)} sigBoost=${(sigBoost * 100).toFixed(1)}% signals=[${pitcherSigs.join(",")}]`);
      }
    }

    console.log(`[LIVE_OPPORTUNITY] player=${output.playerName} market=${output.market} family=${marketFamily} signalScore=${scoreBreakdown.total} edge=${output.edge.toFixed(1)} opportunityScore=${opportunityScore} liveScore=${(liveScore * 100).toFixed(2)} eventBoost=${scoreBreakdown.eventBoost}`);

    const stateFields = this.computeSignalState(gameId, input, output, scoreBreakdown, isBatterOver);

    let signalMode: MLBQualifiedSignal["mode"] = null;
    if (isBatterOver) {
      if (scoreBreakdown.total >= 80) signalMode = "elite";
      else if (scoreBreakdown.total >= 68) signalMode = "strong";
      else if (scoreBreakdown.total >= 55) signalMode = "lean";
      else if (scoreBreakdown.total >= 48) signalMode = "heating_up";
      else if (scoreBreakdown.total >= 42) signalMode = "watch";
    } else {
      if (scoreBreakdown.total >= 85) signalMode = "elite";
      else if (scoreBreakdown.total >= 70) signalMode = "strong";
      else if (scoreBreakdown.total >= 60) signalMode = "lean";
      else if (scoreBreakdown.total >= 50) signalMode = "heating_up";
      else if (scoreBreakdown.total >= 40) signalMode = "watch";
    }

    if (output.market === "home_runs" && hrRadarResult) {
      if (hrRadarResult.total >= 80) signalMode = "hr_elite";
      else if (hrRadarResult.total >= 65) signalMode = "hr_strong";
      else if (hrRadarResult.total >= 50) signalMode = "hr_heating_up";
      else if (hrRadarResult.total >= HR_WATCH_GATE) signalMode = "hr_watch";
    }

    // [MLB Phase 2.5 + Phase 3.5] When near-HR contact is confirmed, enrich
    // signalTags with the spec drivers so UI / analytics can see the watch
    // reason. We DO NOT touch engineProbability, calibratedProbability*,
    // evPct, or edge here — Phase 1/1.5 invariants stay frozen.
    let stampSignalType: "hr_watch" | undefined = undefined;
    if (nearHrResult.tier) {
      for (const d of nearHrResult.drivers) {
        if (!signalTags.includes(d as any)) (signalTags as string[]).push(d);
      }
      // Stamp signalType:"hr_watch" only when the surfaced mode actually
      // lands in the watch band (don't overwrite a player who's already
      // posting an elite/strong/lean signal on this market).
      const isWatchBand = signalMode === "hr_watch" || signalMode === "hr_heating_up" ||
                          signalMode === "watch" || signalMode === "heating_up" ||
                          signalMode === null;
      if (isWatchBand) {
        stampSignalType = "hr_watch";
        // "lean" tier upgrade per spec: only if the underlying scoreBreakdown
        // already supports lean (don't fabricate it from contact alone).
        if (nearHrResult.tier === "lean" && scoreBreakdown.total >= 55 && signalMode === "hr_watch") {
          // Keep mode as hr_watch but log the upgrade-eligible state — actual
          // mode promotion stays gated by signalScore so we never bypass
          // qualification math.
          console.log(`[MLB_HR_WATCH_LEAN_ELIGIBLE] ${output.playerName}/${output.market} nearHr=lean signalScore=${scoreBreakdown.total} mode=${signalMode}`);
        }
      }
      console.log("[MLB_HR_WATCH_CONTEXT_USED]", {
        player: output.playerName,
        market: output.market,
        nearHrTier: nearHrResult.tier,
        signalMode,
        signalScore: scoreBreakdown.total,
        hrWatchGate: HR_WATCH_GATE,
        signalType: stampSignalType ?? null,
        driversInjected: nearHrResult.drivers.length,
      });
      // Phase 3 — record into ring buffer so admin debug endpoint can show
      // a counter + recent list. Lazy import to avoid load-order coupling.
      import("./diagnosticsBuffer").then((d) => {
        d.recordHrWatchContext({
          player: output.playerName ?? null,
          market: output.market ?? null,
          nearHrCount: nearHrResult.drivers.length,
          contactScore: hrRadarResult?.total ?? null,
          affectedSignalScore: scoreBreakdown.total,
          affectedProbability: typeof (output as any).engineProbability === "number" ? (output as any).engineProbability : null,
          signalTier: canonicalSignalTier ?? null,
        });
      }).catch(() => {});

      // [MLB Phase 3B] HR Watch → signalScore additive nudge.
      // Strict invariant: this NEVER touches engineProbability,
      // calibratedProbabilityOver/Under, or evPct. It only nudges
      // scoreBreakdown.total (and the derived confidenceTier/signalMode)
      // so a near-HR batter gets credit in the signal composition layer
      // without inflating the underlying probability.
      const bump = nearHrResult.tier === "lean" ? 6 : nearHrResult.tier === "watch" ? 3 : 0;
      if (bump > 0) {
        const oldTotal = scoreBreakdown.total;
        const newTotal = Math.max(0, Math.min(100, oldTotal + bump));
        scoreBreakdown.total = newTotal;
        // Re-derive confidenceTier per existing thresholds (signalScore.ts:
        // 85=ELITE / 70=STRONG / 55=SOLID / 40=WATCHLIST / else NO_SIGNAL).
        if (newTotal >= 85) scoreBreakdown.confidenceTier = "ELITE";
        else if (newTotal >= 70) scoreBreakdown.confidenceTier = "STRONG";
        else if (newTotal >= 55) scoreBreakdown.confidenceTier = "SOLID";
        else if (newTotal >= 40) scoreBreakdown.confidenceTier = "WATCHLIST";
        else scoreBreakdown.confidenceTier = "NO_SIGNAL";
        try {
          // Phase 1 STEP 2 — enriched score-bump diagnostic so an audit can
          // tell WHICH AB triggered the lean/watch and which drivers were
          // injected, plus the gate state before/after the bump.
          const bumpPayload = {
            playerId: (input as any).playerId ?? null,
            playerName: output.playerName,
            market: output.market,
            sourceAbIndex: nearHrPeak.sourceAbIndex,
            tier: nearHrResult.tier,
            matchedPath: nearHrResult.matchedPath ?? null,
            repeatedDanger: nearHrResult.repeatedDanger === true,
            oldScore: oldTotal,
            bump,
            newScore: newTotal,
            gateBefore: 35,
            gateAfter: HR_WATCH_GATE,
            driversAdded: nearHrResult.drivers,
          };
          console.log("[MLB_HR_WATCH_SCORE_BUMP]", JSON.stringify(bumpPayload));
        } catch {}
      }
    }

    // HIGH_PROB_BYPASS rescue: if we surfaced this signal solely because the
    // calibrated probability is strong on its own, the existing tier ladders
    // (which key off scoreBreakdown.total) may still leave signalMode null
    // because the in-game score is below the lowest "watch" cutoff. Force it
    // into the "watch" tier so it actually renders, and tag it so the UI can
    // distinguish probability-driven entries from in-game-momentum entries.
    if (bypassedByHighProb) {
      if (!signalMode) signalMode = "watch";
      if (!feedTags.includes("HIGH_PROB" as any)) (feedTags as string[]).push("HIGH_PROB");
      if (!signalTags.includes("HIGH_PROB" as any)) (signalTags as string[]).push("HIGH_PROB");
    }

    // [MLB Canonical Probability v1] Recommended-side calibrated probability is
    // the single source of truth across Engine → API → DB → Analytics → UI.
    // For OVER recommendations we expose calibratedProbabilityOver; for UNDER
    // we expose calibratedProbabilityUnder. The previous dominant value is
    // preserved on engineProbabilityDominant for diagnostics only — never used
    // for persistence, analytics bucketing, or UI rendering.
    const sidedCalibrated = getCanonicalSidedProbability(output);
    const previousDominantProbability = output.calibratedProbability;
    console.log("[MLB_CANONICAL_PROBABILITY]", {
      player: output.playerName,
      market: output.market,
      recommendedSide: output.recommendedSide,
      calibratedProbabilityOver: output.calibratedProbabilityOver,
      calibratedProbabilityUnder: output.calibratedProbabilityUnder,
      previousDominantProbability,
      canonicalProbability: sidedCalibrated,
    });

    // [MLB Canonical Signal Tier — Phase 2] Derive the canonical lowercase
    // 4-state tier ONCE here from the existing confidenceTier so every
    // downstream consumer (UI, topPlays, analytics, calculator) renders the
    // SAME value. Underlying scoring formulas are untouched — this is a
    // tier-name normalization, not a re-tiering.
    const canonicalSignalTier = deriveSignalTier(scoreBreakdown.confidenceTier);
    console.log("[MLB_SIGNAL_TIER]", {
      player: output.playerName,
      market: output.market,
      recommendedSide: output.recommendedSide,
      signalScore: scoreBreakdown.total,
      confidenceTier: scoreBreakdown.confidenceTier,
      signalTier: canonicalSignalTier,
      mode: signalMode,
    });

    const signal: MLBQualifiedSignal = {
      id: `${gameId}_${output.playerId}_${output.market}`,
      gameId,
      playerId: output.playerId,
      playerName: output.playerName,
      team: (output as any).team ?? input.team ?? "",
      market: output.market,
      side: output.recommendedSide,
      sportsbook: output.sportsbook,
      line: output.bookLine,
      impliedProbability: null,
      engineProbability: sidedCalibrated,
      engineProbabilityDominant: previousDominantProbability,
      calibratedProbabilityOver: output.calibratedProbabilityOver,
      calibratedProbabilityUnder: output.calibratedProbabilityUnder,
      probabilitySemantics: "recommended_side_calibrated",
      projection: adjustedProjection,
      evPct: output.evPct,
      confidenceTier: scoreBreakdown.confidenceTier,
      signalTier: canonicalSignalTier,
      // [MLB Phase 2.5] Stamped only when detectNearHrContact() qualified
      // this player's last AB AND the surfaced mode lands in the watch band.
      signalType: stampSignalType,
      // [MLB Phase 3] Engine-owned calibration version stamp. Sourced from
      // diagnosticsBuffer.MLB_CALIBRATION_VERSION so the constant has a
      // single source of truth. Current value covers Phase 1 canonical prob,
      // Phase 1.5 caps, Phase 2 tier unification, Phase 2.5 near-HR detection,
      // and Phase 3 market-calibration audit (HRR + hits_allowed logging).
      calibrationVersion: MLB_CALIBRATION_VERSION,
      signalScore: scoreBreakdown.total,
      reasons: output.explanationBullets,
      feedTags: feedTags as string[],
      signalTags: signalTags as string[],
      playerGlowEligible: glowEligible,
      gameCardSignalTags: [],
      formIndicator: output.formIndicator,
      isExperimental: output.isExperimental,
      engineGeneratedAt: output.engineGeneratedAt,
      badges: output.computedBadges ?? [],
      riskFlags: output.computedRiskFlags ?? [],
      drivers: {
        edge: output.edge,
        probability: sidedCalibrated,
        projection: adjustedProjection,
        formScore: output.formScore,
        contextScore: output.contextScore,
        ...(output.featureScores ?? {}),
      },
      timestamps: {
        engineGeneratedAt: new Date(output.engineGeneratedAt).toISOString(),
        oddsUpdatedAt: new Date(output.oddsUpdatedAt).toISOString(),
        gameStateUpdatedAt: new Date(output.projectionUpdatedAt).toISOString(),
      },
      ...stateFields,
    };

    signal.mode = signalMode;
    signal.signalStrengthScore = scoreBreakdown.total;
    signal.marketFamily = marketFamily;
    signal.hrRadarScore = hrRadarResult?.total ?? undefined;
    signal.pitcherAnalysis = output.pitcherAnalysis ?? null;
    signal.pitcherSignals = pitcherSigs.length > 0 ? pitcherSigs : (output.pitcherSignals ?? null);
    signal.opportunityScore = opportunityScore;
    signal.liveScore = Math.round(liveScore * 10000) / 10000;
    signal.eventBoost = scoreBreakdown.eventBoost;

    if (output.market === "home_runs" || output.market === "hrr") {
      const ohEnrichment = getOnlyHomersEnrichment(output.playerName);
      (signal as any).isHotHitter = ohEnrichment.isHotHitter;
      (signal as any).hotHitterPeriod = ohEnrichment.hotHitterPeriod;
      (signal as any).hotHitterHrCount = ohEnrichment.hotHitterHrCount;
      if (ohEnrichment.isHotHitter) {
        signal.badges = [...(signal.badges ?? []), "HOT_HITTER"];
        if (!signal.reasons) signal.reasons = [];
        signal.reasons.push(`Hot hitter: ${ohEnrichment.hotHitterHrCount} HRs in last ${ohEnrichment.hotHitterPeriod}`);
      }
    }

    if (signal.fallbackUsed) {
      signal.confidenceTier = "WATCHLIST" as any;
      signal.watchlist = true;
      signal.actionable = false;
    }

    // Plan D + E: stamp early-bypass signals as Pre-AB Watch entries so the
    // UI band (which keys off isEarlySignal) picks them up, while the main
    // feed (which gates on confidenceTier ELITE/STRONG and signalScore) does
    // not. We only touch surfacing flags here — scoring/calibration untouched.
    if (bypassedAsEarly && earlyBypassTag) {
      signal.confidenceTier = "WATCHLIST" as any;
      (signal as any).watchlist = true;
      (signal as any).actionable = false;
      (signal as any).isEarlySignal = true;
      if (!signal.mode) signal.mode = "watch";
      const tag = earlyBypassTag;
      if (!signal.feedTags.includes(tag)) (signal.feedTags as string[]).push(tag);
      if (!signal.signalTags.includes(tag)) (signal.signalTags as string[]).push(tag);
      console.log(`[MLB QUALIFY EARLY_BYPASS_STAMP][${gameId}] ${output.playerName}/${output.market} — tag=${tag} prob=${sideProbability.toFixed(1)}`);
    }

    (signal as any).isDegraded = !!(input as any).isDegraded;

    this.sanitizeUserFacingFields(signal);

    // Phase C+D: Build the diagnostics envelope from existing data only.
    // Placed AFTER fallback/early-bypass stamping AND sanitizeUserFacingFields
    // so the captured feedTags/signalTags/badges/riskFlags/fallbackUsed reflect
    // the final user-facing state. No recomputation — we surface featureScores,
    // scoreBreakdown subscores, and BvP/WeatherPark/Handedness snapshots
    // verbatim, plus a small set of human-readable driver lines derived from
    // those same fields.
    signal.diagnostics = buildSignalDiagnostics({
      input,
      output,
      scoreBreakdown,
      feedTags: signal.feedTags,
      signalTags: signal.signalTags,
      badges: signal.badges,
      riskFlags: signal.riskFlags,
      fallbackUsed: !!signal.fallbackUsed,
    });

    if (signal.fallbackUsed) {
      console.log(`[MLB_FALLBACK_USED] player=${output.playerName} market=${output.market} defaultRate=fallback`);
    }

    if (isBatterOver || output.market === "home_runs") {
      console.log(`[SIGNAL_ENGINE] player=${output.playerName} market=${output.market} family=${marketFamily} mode=${signalMode} sss=${scoreBreakdown.total} edge=${output.edge?.toFixed(1)} prob=${output.calibratedProbability?.toFixed(1)} actionable=${signal.actionable}${hrRadarResult ? ` hrRadar=${hrRadarResult.total}` : ""}`);
    }

    if (process.env.DEBUG_PIPELINE === "true") {
      console.log(`[MLB_SIGNAL_BUILT] gameId=${gameId} player=${output.playerName} market=${output.market} prob=${output.calibratedProbability?.toFixed(1)} edge=${output.edge?.toFixed(1)} actionable=${signal.actionable} fallback=${signal.fallbackUsed}`);
    }

    return signal;
  }

  private computeSignalState(
    gameId: string,
    input: MLBPropInput,
    output: MLBPropOutput,
    scoreBreakdown: { total: number; confidenceTier: string },
    isBatterOver: boolean = false
  ) {
    const gameState = mlbGameCache.gameState[gameId];
    const boxScore = mlbGameCache.gameBoxScore?.[gameId];
    const boxPlayer = boxScore?.byPlayerId?.[input.playerId];

    const boxStat = input.currentStatValue ?? 0;
    const line = output.bookLine;
    // HR Radar audit fix #1 — race-proof alreadyHit. The play-feed grader stamps
    // RESOLVED_HR_PLAYERS the moment it sees a HR, before the box-score syncs
    // currentStatValue. Trust that signal first. Otherwise fall back to the
    // box-score-based comparison.
    const isHrMarket = output.market === "home_runs";
    const isHrResolvedNow = isHrMarket && RESOLVED_HR_PLAYERS.has(`${gameId}_${input.playerId}`);
    // MLB Signals audit P1 — same race-proof pattern for ALL non-HR batter
    // markets. Take the freshest of (box-score, play-feed) as currentStat,
    // and treat the prop as resolved if either the play-feed-stamped set
    // says so or the merged stat already crosses the line. This ensures
    // hits / TB / hrr / batter_strikeouts cards leave the bettable feed
    // within the same tick the resolving play lands, regardless of
    // box-score sync lag.
    const playFeedStat = getPlayFeedBatterStatCount(gameId, input.playerId, output.market);
    const currentStat = Math.max(boxStat, playFeedStat);
    const isNonHrResolvedNow = !isHrMarket &&
      RESOLVED_NON_HR_MARKETS.has(`${gameId}_${input.playerId}_${output.market}`);
    const alreadyHit = isHrResolvedNow || isNonHrResolvedNow ||
      (currentStat >= line && line > 0);

    const isFallback = output.fallbackUsed === true;
    const isStale = output.engineGeneratedAt > 0 && (Date.now() - output.engineGeneratedAt) > 120_000;
    const watchlistThreshold = isBatterOver ? 42 : 55;
    const isWatchlist = isBatterOver
      ? (scoreBreakdown.total < watchlistThreshold || isFallback)
      : (scoreBreakdown.confidenceTier === "WATCHLIST" || scoreBreakdown.total < watchlistThreshold || isFallback);
    const edgeOk = isBatterOver ? true : output.edge > 0;
    const isActionable = !alreadyHit && !isStale && !isWatchlist && !isFallback
      && edgeOk && (output.overOdds !== null || output.underOdds !== null);

    const pitcher = gameState?.pitcherInGame;
    const pitcherCtxCache = mlbGameCache.pitcherContext?.[gameId];
    const pitcherCtx = pitcher?.playerId ? pitcherCtxCache?.byPitcherId?.[pitcher.playerId] : undefined;

    const contactCache = mlbGameCache.contactData?.[gameId];
    const playerContactData = contactCache?.byPlayerId?.[input.playerId];
    const priorABResults = (playerContactData?.priorABResults ?? []).map((ab: any) => ({
      outcome: ab.outcome ?? "unknown",
      exitVelocity: ab.exitVelocity ?? null,
      launchAngle: ab.launchAngle ?? null,
      pitchType: ab.pitchType ?? null,
      pitchSpeed: ab.pitchSpeed ?? null,
    }));

    const oddsAge = output.oddsUpdatedAt ? Date.now() - output.oddsUpdatedAt : 0;
    const oddsStale = oddsAge > 900_000;
    if (oddsStale) {
      console.log(`[MLB_ODDS_STALE] player=${input.playerName} market=${input.market} ageMs=${oddsAge}`);
    }

    // MLB Signals audit P2/P3 — recompute the non-HR engine state machine on
    // every tick (state machine + decay rail). HR markets are excluded;
    // they have their own dedicated state machine in hrAlertEngine.ts
    // (recomputeHrAlertState above).
    let nonHrEngineState: NonHrSignalState | undefined;
    let nonHrEngineChangedAt: number | undefined;
    let nonHrEnginePeak: number | undefined;
    let nonHrDecayFactor: number | undefined;
    if (!isHrMarket) {
      const isPitcherMarket =
        output.market === "pitcher_strikeouts" ||
        output.market === "pitcher_outs" ||
        output.market === "hits_allowed" ||
        output.market === "walks_allowed" ||
        output.market === "hr_allowed";
      const paCount = isPitcherMarket ? 0 : (priorABResults.length ?? 0);
      // For pitcher markets the player is the pitcher — read pitchCount from
      // the pitcherContext cache keyed by this same playerId, falling back
      // to the game-level pitcher pitchCount tracked on gameState.
      const pitcherCtxForPlayer = mlbGameCache.pitcherContext?.[gameId]?.byPitcherId?.[input.playerId];
      const pitchCount = isPitcherMarket
        ? (pitcherCtxForPlayer?.pitchCount ?? gameState?.pitchCount ?? 0)
        : 0;
      const nonHrSnap = recomputeNonHrSignalState({
        gameId,
        playerId: input.playerId,
        playerName: input.playerName,
        market: output.market,
        signalScore: scoreBreakdown.total,
        paCount,
        pitchCount,
        resolvedNow: isNonHrResolvedNow || alreadyHit,
      });
      nonHrEngineState = nonHrSnap.state;
      nonHrEngineChangedAt = nonHrSnap.lastTransitionAt;
      nonHrEnginePeak = nonHrSnap.peakScore;
      nonHrDecayFactor = nonHrSnap.decayFactor;
    }

    return {
      fallbackUsed: isFallback,
      actionable: isActionable && !oddsStale,
      alreadyHit,
      stale: isStale || oddsStale,
      watchlist: isWatchlist,
      engineState: nonHrEngineState,
      engineStateChangedAt: nonHrEngineChangedAt,
      engineStatePeakScore: nonHrEnginePeak,
      decayFactor: nonHrDecayFactor,
      overOdds: output.overOdds ?? null,
      underOdds: output.underOdds ?? null,
      oddsTimestamp: output.oddsUpdatedAt ?? null,
      pitcherName: pitcher?.playerName ?? null,
      pitcherHand: pitcher?.throws ?? null,
      pitcherPitchCount: pitcherCtx?.pitchCount ?? gameState?.pitchCount ?? null,
      pitcherTimesThrough: pitcherCtx?.timesThroughOrder ?? null,
      homeScore: gameState?.homeScore ?? 0,
      awayScore: gameState?.awayScore ?? 0,
      inning: gameState?.inning ?? input.inning,
      isTopInning: gameState?.isTopInning ?? input.isTopInning,
      currentStat,
      completedAB: input.completedAB,
      bookImplied: output.bookImplied ?? null,
      priorABResults,
    };
  }

  private buildWatchSignal(gameId: string, input: MLBPropInput, output: MLBPropOutput): MLBQualifiedSignal | null {
    let effectiveSide = output.recommendedSide;
    if (effectiveSide !== "OVER" && effectiveSide !== "UNDER") {
      const overP = output.calibratedProbabilityOver ?? 0;
      const underP = output.calibratedProbabilityUnder ?? 0;
      if (overP > underP && overP > 0) effectiveSide = "OVER";
      else if (underP > 0) effectiveSide = "UNDER";
      else return null;
    }

    if (((output.market as string) === "hr" || output.market === "home_runs") && effectiveSide === "UNDER") {
      return null;
    }

    const bookLine = typeof output.bookLine === "number" && Number.isFinite(output.bookLine) && output.bookLine > 0
      ? output.bookLine
      : (typeof output.projection === "number" && Number.isFinite(output.projection) ? Math.round(output.projection * 2) / 2 : null);
    if (bookLine === null) return null;

    const sideProbability = effectiveSide === "OVER"
      ? output.calibratedProbabilityOver
      : output.calibratedProbabilityUnder;
    if (!Number.isFinite(sideProbability) || sideProbability <= 0) return null;

    const scoreBreakdown = computeSignalScore(input, output);
    const signalTags = deriveSignalTags(input, output, scoreBreakdown);
    // HR Radar audit fix #4 — same HR-resolved guard as the qualified path.
    const isHrResolvedPlayerWatch = output.market === "home_runs" &&
      RESOLVED_HR_PLAYERS.has(`${gameId}_${input.playerId}`);
    const feedTags = deriveFeedTags(input, output, scoreBreakdown, { isHrResolved: isHrResolvedPlayerWatch });
    const watchPitcherSigsForProj = derivePitcherSignals(input, output);
    const stateFields = this.computeSignalState(gameId, input, output, scoreBreakdown);

    let watchAdjProjection = output.projection;
    const isWatchPitcherMarket = ["pitcher_strikeouts", "pitcher_outs", "hits_allowed"].includes(output.market);
    if (isWatchPitcherMarket && watchPitcherSigsForProj.length > 0) {
      let sigBoost = 0;
      for (const ps of watchPitcherSigsForProj) {
        if (ps === "DOMINANT") sigBoost += 0.08;
        else if (ps === "K_STREAK") sigBoost += 0.06;
        else if (ps === "COMMAND_LOCKED") sigBoost += 0.04;
        else if (ps === "FATIGUE_RISK") sigBoost -= 0.05;
        else if (ps === "VELOCITY_DROP") sigBoost -= 0.04;
        else if (ps === "HARD_CONTACT") sigBoost -= 0.06;
      }
      watchAdjProjection = output.projection + output.projection * sigBoost;
    }

    // [MLB Canonical Probability v1] Same recommended-side rule applies to
    // watchlist signals — sideProbability is already computed above for the
    // gating check; reuse it as the canonical engine probability instead of
    // the dominant calibratedProbability.
    console.log("[MLB_CANONICAL_PROBABILITY]", {
      player: output.playerName,
      market: output.market,
      recommendedSide: effectiveSide,
      calibratedProbabilityOver: output.calibratedProbabilityOver,
      calibratedProbabilityUnder: output.calibratedProbabilityUnder,
      previousDominantProbability: output.calibratedProbability,
      canonicalProbability: sideProbability,
      lane: "watch",
    });

    const watchSignal: MLBQualifiedSignal = {
      id: `${gameId}_${output.playerId}_${output.market}`,
      gameId,
      playerId: output.playerId,
      playerName: output.playerName,
      team: (output as any).team ?? input.team ?? "",
      market: output.market,
      side: effectiveSide as "OVER" | "UNDER",
      sportsbook: output.sportsbook,
      line: bookLine,
      impliedProbability: null,
      engineProbability: sideProbability,
      engineProbabilityDominant: output.calibratedProbability,
      calibratedProbabilityOver: output.calibratedProbabilityOver,
      calibratedProbabilityUnder: output.calibratedProbabilityUnder,
      probabilitySemantics: "recommended_side_calibrated",
      projection: watchAdjProjection,
      evPct: output.evPct,
      confidenceTier: scoreBreakdown.total >= 55 ? scoreBreakdown.confidenceTier : "WATCHLIST" as any,
      signalScore: scoreBreakdown.total,
      reasons: output.explanationBullets,
      feedTags: feedTags as string[],
      signalTags: signalTags as string[],
      playerGlowEligible: false,
      gameCardSignalTags: [],
      formIndicator: output.formIndicator,
      isExperimental: output.isExperimental,
      engineGeneratedAt: output.engineGeneratedAt,
      badges: output.computedBadges ?? [],
      riskFlags: output.computedRiskFlags ?? [],
      drivers: {
        edge: output.edge,
        probability: sideProbability,
        projection: watchAdjProjection,
        formScore: output.formScore,
        contextScore: output.contextScore,
        ...(output.featureScores ?? {}),
      },
      timestamps: {
        engineGeneratedAt: new Date(output.engineGeneratedAt).toISOString(),
        oddsUpdatedAt: new Date(output.oddsUpdatedAt).toISOString(),
        gameStateUpdatedAt: new Date(output.projectionUpdatedAt).toISOString(),
      },
      ...stateFields,
      watchlist: true,
      actionable: false,
    };

    watchSignal.pitcherAnalysis = output.pitcherAnalysis ?? null;
    watchSignal.pitcherSignals = watchPitcherSigsForProj.length > 0 ? watchPitcherSigsForProj : (output.pitcherSignals ?? null);
    const watchOppScore = computeFullOpportunityScore(input, input.inning);
    const watchLiveScore = computeLiveOpportunityScore(scoreBreakdown.total, output.edge, watchOppScore);
    watchSignal.opportunityScore = watchOppScore;
    watchSignal.liveScore = Math.round(watchLiveScore * 10000) / 10000;
    watchSignal.eventBoost = scoreBreakdown.eventBoost;

    this.sanitizeUserFacingFields(watchSignal);

    // Phase C+D: same diagnostics envelope on watchlist signals so the UI
    // can render explainability for Pre-AB Watch entries identically.
    watchSignal.diagnostics = buildSignalDiagnostics({
      input,
      output,
      scoreBreakdown,
      feedTags: watchSignal.feedTags,
      signalTags: watchSignal.signalTags,
      badges: watchSignal.badges,
      riskFlags: watchSignal.riskFlags,
      fallbackUsed: !!watchSignal.fallbackUsed,
    });

    return watchSignal;
  }

  async periodicHRRadarRosterScan(gameId: string): Promise<void> {
    const lastScan = hrRosterScanLastRun.get(gameId) ?? 0;
    const sinceLast = Date.now() - lastScan;
    if (sinceLast < HR_ROSTER_SCAN_INTERVAL_MS) {
      return;
    }
    hrRosterScanLastRun.set(gameId, Date.now());

    const state = mlbGameCache.gameState[gameId];
    if (!state || !state.battingOrder?.length) {
      console.log(`[HR_RADAR_PERIODIC_SCAN_TICK] game=${gameId} skipped — no battingOrder cached`);
      return;
    }

    const contactCache = mlbGameCache.contactData[gameId];
    const allChanges: ContactChangeEvent[] = [];
    let battersWithContact = 0;

    for (const batter of state.battingOrder) {
      const playerContact = contactCache?.byPlayerId?.[batter.playerId];
      const priorABs = (playerContact?.priorABResults ?? []) as any[];
      if (!priorABs.length) continue;
      battersWithContact++;

      const scanKey = `${gameId}:${batter.playerId}`;
      const lastABCount = hrRosterScanLastABCount.get(scanKey) ?? 0;
      // First scan or new AB recorded → include batter. The previous strict
      // ">" check meant on first attempt with priorABs already full, the
      // counter would be set and equality would block the next scan even
      // though no rebuild ever happened. Include on first scan (lastABCount=0)
      // OR when new ABs since last scan.
      const isFirstScan = lastABCount === 0;
      if (!isFirstScan && priorABs.length <= lastABCount) continue;
      hrRosterScanLastABCount.set(scanKey, priorABs.length);

      allChanges.push({
        playerId: batter.playerId,
        playerName: batter.playerName,
        newABCount: priorABs.length,
        prevABCount: lastABCount,
        latestAB: priorABs.slice(-1)[0] ?? null,
      });
    }

    console.log(`[HR_RADAR_PERIODIC_SCAN_TICK] game=${gameId} battersInOrder=${state.battingOrder.length} battersWithContact=${battersWithContact} changesQueued=${allChanges.length}`);

    if (allChanges.length > 0) {
      console.log(`[HR_RADAR_ROSTER_SCAN] game=${gameId} evaluating ${allChanges.length} batters with contact data`);
      await this.reevaluateHRRadarOnContact(gameId, allChanges);
    }
  }

  async reevaluateHRRadarOnContact(gameId: string, contactChanges: ContactChangeEvent[]): Promise<void> {
    const state = mlbGameCache.gameState[gameId];
    if (!state || !state.battingOrder?.length) return;

    const contactCache = mlbGameCache.contactData[gameId];
    const pitcherCtxCache = mlbGameCache.pitcherContext?.[gameId];
    const weatherCache = mlbGameCache.weather[gameId];
    const bullpenCache = mlbGameCache.bullpen[gameId];

    const pitcher = state.pitcherInGame;
    const pitcherCtx = pitcher ? pitcherCtxCache?.byPitcherId?.[pitcher.playerId] : undefined;
    const pitcherSeasonStats = pitcher ? mlbPlayerCache.pitcherSeasonStats[pitcher.playerId] : undefined;

    const isPitcherCollapsing = pitcherCtx
      ? (pitcherCtx.velocityDrop !== null && pitcherCtx.velocityDrop > 2)
      : false;

    const hourlyWeather = resolveCurrentHourWeather(gameId);
    const resolvedTemp = hourlyWeather?.temperature ?? weatherCache?.temperature ?? null;
    const resolvedWindSpeed = hourlyWeather?.windSpeed ?? weatherCache?.windSpeed ?? null;
    const resolvedWindDir = hourlyWeather?.windDirection ?? weatherCache?.windDirection ?? null;

    for (const change of contactChanges) {
      const batter = state.battingOrder.find(b => b.playerId === change.playerId);
      if (!batter) continue;

      const playerContact = contactCache?.byPlayerId?.[change.playerId];
      if (!playerContact?.priorABResults?.length) continue;

      const rosterLookup = getPlayer(batter.playerId);
      const resolvedBatterHand: "L" | "R" | "S" | null = rosterLookup?.bats ?? null;
      const rollingStats = mlbPlayerCache.batterRollingStats[batter.playerId];

      const { remainingPA } = estimateRemainingPA(
        state.inning,
        state.isTopInning,
        batter.slot,
      );

      const hrInput: MLBPropInput = {
        playerId: batter.playerId,
        playerName: batter.playerName,
        team: batter.team,
        opponent: state.homeTeamAbbr && state.awayTeamAbbr
          ? (batter.team === state.homeTeamAbbr ? state.awayTeamAbbr : state.homeTeamAbbr)
          : "",
        gameId,
        market: "home_runs" as MLBMarket,
        bookLine: 0.5,
        overOdds: null,
        underOdds: null,
        seasonAvg: 0.04,
        plateAppearances: state.pitchCount > 0 ? Math.max(1, state.battingOrder.length) : 0,
        atBats: mlbGameCache.gameBoxScore[gameId]?.byPlayerId?.[batter.playerId]?.ab ?? 0,
        currentStatValue: mlbGameCache.gameBoxScore[gameId]?.byPlayerId?.[batter.playerId]?.hr ?? 0,
        remainingPA,
        remainingAB: remainingPA,
        completedAB: mlbGameCache.gameBoxScore[gameId]?.byPlayerId?.[batter.playerId]?.ab ?? 0,
        inning: state.inning,
        isTopInning: state.isTopInning,
        currentGameHR: mlbGameCache.gameBoxScore[gameId]?.byPlayerId?.[batter.playerId]?.hr ?? 0,
        hardHitCount: (playerContact.priorABResults ?? []).filter((ab: any) => (ab.exitVelocity ?? 0) >= 95).length,
        batterHand: resolvedBatterHand,
        contactQuality: {
          exitVelocity: playerContact.exitVelocity ?? null,
          launchAngle: playerContact.launchAngle ?? null,
          hitDistance: playerContact.hitDistance ?? null,
          hardHitRateSeason: playerContact.hardHitPct != null ? playerContact.hardHitPct / 100 : null,
          barrelRateProxySeason: playerContact.barrelPct != null ? playerContact.barrelPct / 100 : null,
          avgBatSpeed: playerContact.avgBatSpeed ?? null,
          avgSwingLength: playerContact.avgSwingLength ?? null,
          priorABResults: (playerContact.priorABResults ?? []) as MLBPropInput["contactQuality"]["priorABResults"],
          xBA: playerContact.xBA ?? null,
          xSLG: playerContact.xSLG ?? null,
          learnedHitLikelihood: null,
          learnedHrLikelihood: null,
          pitchTypeHrRisk: null,
        },
        pitcher: {
          pitchCount: pitcher ? state.pitchCount : 0,
          timesThrough: pitcherCtx?.timesThroughOrder ?? 1,
          era: pitcherSeasonStats?.era ?? null,
          whip: pitcherSeasonStats?.whip ?? null,
          kPer9: pitcherSeasonStats?.kPer9 ?? null,
          bbPer9: pitcherSeasonStats?.bbPer9 ?? null,
          managerLeashShort: pitcherCtx ? pitcherCtx.timesThroughOrder >= 3 && pitcherCtx.pitchCount > 80 : false,
          isPitcherCollapsing,
          pitchMix: pitcherCtx?.pitchMix ?? [],
          throws: pitcher?.throws ?? null,
          seasonAvgVelocity: pitcherCtx?.seasonAvgVelocity ?? null,
        },
        ...(rollingStats ? {
          hrTrend: {
            abSinceLastHR: rollingStats.abSinceLastHR,
            hrRateLast7: rollingStats.hrRateLast7,
            hrRateLast15: rollingStats.hrRateLast15,
            hrRateLast30: rollingStats.hrRateLast30,
            seasonTotalHR: rollingStats.seasonTotalHR,
            seasonTotalAB: rollingStats.seasonTotalAB,
          },
        } : {}),
        lineup: {
          battingOrderSlot: batter.slot,
          orderTurnoverProximity: 0.5,
          lineupSectionStrength: batter.slot <= 3 ? "strong" : batter.slot <= 6 ? "neutral" : "weak",
          hittersAheadOnBase: state.runnersOnBase.length,
          pocketWeakness: null,
        },
        weatherPark: {
          parkFactor: getMarketParkFactor(weatherCache?.venueName, "home_runs", resolvedBatterHand),
          temperature: resolvedTemp,
          windSpeed: resolvedWindSpeed,
          windDirection: resolvedWindDir,
          humidity: hourlyWeather?.humidity ?? weatherCache?.humidity ?? null,
          isIndoors: weatherCache?.isIndoors ?? isVenueIndoors(weatherCache?.venueName),
          parkHistoryFactor: null,
          windShiftDetected: false,
        },
        bullpen: {
          bullpenEra: bullpenCache?.bullpenEra ?? null,
          bullpenUsageLastThreeDays: bullpenCache?.bullpenUsageLastThreeDays ?? null,
          isTopRelieverAvailable: bullpenCache?.isTopRelieverAvailable ?? true,
        },
      };

      const ohData = getOnlyHomersEnrichment(batter.playerName);
      if (ohData.isHotHitter) {
        const boost = ohData.hotHitterPeriod === "7d" ? 0.8 : ohData.hotHitterPeriod === "14d" ? 0.5 : 0.3;
        hrInput.hotHitterBoost = boost;
      }

      // Gap 3: pre-game pitcher fatigue for HR Radar path
      if (pitcherCtx) {
        hrInput.pitcherEntryFatigue = {
          lastStartPitchCount: pitcherCtx.lastStartPitchCount ?? null,
          daysSinceLastStart: pitcherCtx.daysSinceLastStart ?? null,
          last3StartERA: pitcherCtx.last3StartERA ?? null,
        };
      }

      hrInput.liveInterpretation = buildLiveEventInterpretation(hrInput);

      const hrBuild = buildHRSignal(hrInput);
      if (hrBuild.score <= 0) continue;

      const isReliever = bullpenCache?.relieversUsed?.some(
        r => r.playerId === pitcher?.playerId
      ) ?? false;
      let relieverEra: number | null = null;
      if (isReliever && pitcher?.playerId) {
        relieverEra = pitcherSeasonStats?.era ?? null;
      }

      let starterEra: number | null = null;
      if (isReliever && pitcherCtxCache?.byPitcherId && pitcher?.team) {
        const allPitcherIds = Object.keys(pitcherCtxCache.byPitcherId);
        const relieverIds = new Set(
          (bullpenCache?.relieversUsed ?? []).map(r => r.playerId)
        );
        for (const pid of allPitcherIds) {
          if (pid === pitcher.playerId) continue;
          if (relieverIds.has(pid)) continue;
          const sStats = mlbPlayerCache.pitcherSeasonStats[pid];
          if (sStats?.era != null) {
            starterEra = sStats.era;
            break;
          }
        }
      }

      const pitcherDeteriorationCtx = {
        velocityDrop: pitcherCtx?.velocityDrop ?? null,
        avgVelocity: pitcherCtx?.avgVelocity ?? null,
        seasonAvgVelocity: pitcherCtx?.seasonAvgVelocity ?? null,
        isReliever,
        relieverEra,
        starterEra: isReliever ? starterEra : (pitcherSeasonStats?.era ?? null),
        bullpenEra: bullpenCache?.bullpenEra ?? null,
        bullpenUsageLast3Days: bullpenCache?.bullpenUsageLastThreeDays ?? null,
        relieversUsedCount: bullpenCache?.relieversUsed?.length ?? 0,
      };

      const alertInput: HRAlertInput = {
        playerId: batter.playerId,
        playerName: batter.playerName,
        teamAbbr: batter.team,
        gameId,
        hrBuildScore: hrBuild.score,
        hrIntensity: hrBuild.intensity,
        factors: hrBuild.factors,
        inning: state.inning,
        isTopInning: state.isTopInning,
        battingOrderSlot: batter.slot,
        remainingPA,
        pitchCount: pitcher ? state.pitchCount : 0,
        timesThrough: pitcherCtx?.timesThroughOrder ?? 1,
        isPitcherCollapsing,
        parkFactor: getMarketParkFactor(weatherCache?.venueName, "home_runs", resolvedBatterHand),
        windDirection: resolvedWindDir,
        windSpeed: resolvedWindSpeed,
        temperature: resolvedTemp,
        isIndoors: weatherCache?.isIndoors ?? isVenueIndoors(weatherCache?.venueName),
        batterHand: resolvedBatterHand,
        pitcherThrows: pitcher?.throws ?? null,
        era: pitcherSeasonStats?.era ?? null,
        currentRuns: (state.homeScore != null || state.awayScore != null)
          ? (state.homeScore ?? 0) + (state.awayScore ?? 0)
          : 4.5,
        leagueAvgRuns: 4.5,
        seasonHRRate: rollingStats?.seasonHRRate ?? null,
        barrelRate: playerContact.barrelPct != null ? playerContact.barrelPct / 100 : null,
        hardHitRate: playerContact.hardHitPct != null ? playerContact.hardHitPct / 100 : null,
        xSLG: playerContact.xSLG ?? null,
        abSinceLastHR: rollingStats?.abSinceLastHR ?? null,
        hrRateLast7: rollingStats?.hrRateLast7 ?? null,
        hrRateLast15: rollingStats?.hrRateLast15 ?? null,
        hrRateLast30: rollingStats?.hrRateLast30 ?? null,
        handednessParkFactor: getMarketParkFactor(weatherCache?.venueName, "home_runs", resolvedBatterHand),
        pitcherDeterioration: pitcherDeteriorationCtx,
        leiNearHrScore: hrInput.liveInterpretation?.nearHrScore,
        leiMomentumScore: hrInput.liveInterpretation?.momentumScore,
        leiPitcherFatigueScore: hrInput.liveInterpretation?.pitcherFatigueScore,
        leiVeloDropScore: hrInput.liveInterpretation?.veloDropScore,
        leiConfidenceBoost: hrInput.liveInterpretation?.confidenceBoost,
        leiTags: hrInput.liveInterpretation?.tags,
        priorABResults: (playerContact.priorABResults ?? []).map((ab: any) => ({
          exitVelocity: ab.exitVelocity ?? null,
          launchAngle: ab.launchAngle ?? null,
          distance: ab.distance ?? null,
          outcome: ab.outcome ?? "out",
        })),
        preHrDangerScore: hrBuild.preHrDangerScore,
        dangerFlags: hrBuild.dangerFlags,
        pitchMix: pitcherCtx?.pitchMix ?? null,
        lastStartPitchCount: pitcherCtx?.lastStartPitchCount ?? null,
        daysSinceLastStart: pitcherCtx?.daysSinceLastStart ?? null,
        last3StartERA: pitcherCtx?.last3StartERA ?? null,
      };

      const alertResult = evaluateHRAlert(alertInput);
      if (alertResult.level !== "ALERT" && alertResult.level !== "WATCH") continue;

      const latestEV = change.latestAB?.exitVelocity ?? null;
      console.log(`[HR_RADAR_CONTACT_UPDATE] ${alertResult.level} ${batter.playerName} score=${hrBuild.score} intensity=${hrBuild.intensity} latestEV=${latestEV} triggerReason=${alertResult.triggerReason} state=${alertResult.signalState} game=${gameId} inn=${state.inning}`);

      const resolvedOpponent = state.homeTeamAbbr && state.awayTeamAbbr
        ? (batter.team === state.homeTeamAbbr ? state.awayTeamAbbr : state.homeTeamAbbr)
        : "";

      const tierMap: Record<string, "monitor" | "building" | "strong"> = {
        FORMATION: "monitor",
        BUILDING: "building",
        PEAK: "strong",
        COOLDOWN: "monitor",
      };
      const stateMap: Record<string, "live" | "watching" | "actionable"> = {
        FORMATION: "watching",
        BUILDING: "live",
        PEAK: "actionable",
        COOLDOWN: "watching",
      };

      const lastAB = (playerContact.priorABResults ?? []).slice(-1)[0] as any;
      const contactSnap = lastAB ? {
        ev: lastAB.exitVelocity ?? null,
        la: lastAB.launchAngle ?? null,
        distance: lastAB.distance ?? null,
        hardHit: (lastAB.exitVelocity ?? 0) >= 95,
        barrel: (lastAB.exitVelocity ?? 0) >= 98 && (lastAB.launchAngle ?? 0) >= 20 && (lastAB.launchAngle ?? 0) <= 35,
      } : null;

      const convSnap = alertResult.diagnostics?.hrConversion ? {
        hrConversionProbability: alertResult.diagnostics.hrConversion.hrConversionProbability,
        calibratedProbability: alertResult.diagnostics.hrConversion.calibratedProbability,
        perPAHRRate: alertResult.diagnostics.hrConversion.perPAHRRate,
        expectedRemainingPA: alertResult.diagnostics.hrConversion.expectedRemainingPA,
        liveContactMultiplier: alertResult.diagnostics.hrConversion.liveContactMultiplier,
        pitcherMultiplier: alertResult.diagnostics.hrConversion.pitcherMultiplier,
        environmentMultiplier: alertResult.diagnostics.hrConversion.environmentMultiplier,
        pitcherDeteriorationState: alertResult.diagnostics.hrConversion.pitcherDeteriorationState,
      } : null;

      const diagSnap = alertResult.diagnostics ? {
        alertPath: alertResult.diagnostics.alertPath,
        positiveFactors: alertResult.diagnostics.positiveFactors,
        suppressionFlags: alertResult.diagnostics.suppressionFlags,
        hrShapedCount: alertResult.diagnostics.hrShapedCount,
        missedHrCount: alertResult.diagnostics.missedHrCount,
        eliteHrCount: alertResult.diagnostics.eliteHrCount,
        qualifiedEVMean: alertResult.diagnostics.qualifiedEVMean,
        maxDistance: alertResult.diagnostics.maxDistance,
        remainingPA: alertResult.diagnostics.remainingPA,
        pitcherFatigueState: alertResult.diagnostics.pitcherFatigueState,
        environmentContext: alertResult.diagnostics.environmentContext,
        hrConversion: convSnap,
        confidenceScore: alertResult.confidenceScore,
        contactClasses: alertResult.diagnostics.contactClasses.map(c => ({
          contactClass: c.contactClass, exitVelocity: c.exitVelocity,
          launchAngle: c.launchAngle, distance: c.distance,
          outcome: c.outcome, isBarrel: c.isBarrel,
        })),
        pitcherHrVulnerability: getHrAlertState(gameId, batter.playerId)?.pitcherHrVulnerability ?? null,
      } : null;

      // Pull engine's earliest in-memory detection so the row's detected
      // label reflects when we FIRST noticed the player, not when persistence
      // finally fired (HR Radar detection-drift fix, T002).
      const earlyDetect = getHrAlertState(gameId, batter.playerId);
      // Phase 5: canonical stage now uses the unified pipeline. The
      // contact-update tick has a FRESH PATH evaluator result but the
      // dynamic state machine snapshot is from the previous engine pass
      // (no recomputeHrAlertState call here). We pair them via the same
      // `computeUnifiedCanonicalStage` the engine uses internally so the
      // promotion logic is identical and there is no parallel bridge.
      const contactDynamicStage = earlyDetect ? mapDynamicStateToStage(earlyDetect.currentState) : null;
      const contactCanonicalStage = contactDynamicStage
        ? computeUnifiedCanonicalStage(contactDynamicStage, alertResult.signalState)
        : null;
      // Goldmaster Phase 1, 3, 7 — AB context for the user-facing card.
      const contactPaCount = (playerContact.priorABResults ?? []).length;
      const contactHasLiveAB = contactSnap !== null;
      storage.createOrUpdateHrRadarAlert({
        gameId,
        playerId: batter.playerId,
        playerName: batter.playerName,
        team: batter.team,
        opponent: resolvedOpponent,
        inning: state.inning,
        half: state.isTopInning ? "top" : "bottom",
        readinessScore: hrBuild.score,
        dynamicReadinessScore: earlyDetect?.hrReadinessScore ?? null,
        canonicalStage: contactCanonicalStage,
        dynamicState: earlyDetect?.currentState ?? null,
        plateAppearancesTracked: contactPaCount,
        hasLiveABContext: contactHasLiveAB,
        confidenceTier: tierMap[alertResult.signalState ?? "FORMATION"] ?? "monitor",
        signalState: stateMap[alertResult.signalState ?? "FORMATION"] ?? "live",
        triggerTags: alertResult.triggerReason ? alertResult.triggerReason.split(", ") : [],
        summaryText: alertResult.formattedReason || `${alertResult.decision} — ${alertResult.triggerReason}`,
        contactSnapshot: contactSnap,
        alertPath: alertResult.diagnostics?.alertPath ?? null,
        alertTier: alertResult.alertTier ?? null,
        diagnosticsSnapshot: diagSnap,
        // Canonical HR score contract (Phase 3)
        buildScore: hrBuild.score,
        conversionProbabilityRaw: alertResult.diagnostics?.hrConversion?.hrConversionProbability ?? null,
        conversionProbability: alertResult.diagnostics?.hrConversion?.calibratedProbability ?? null,
        peakConversionProbability: null,
        firstDetectedInning: earlyDetect?.detectedInning ?? null,
        firstDetectedHalf: earlyDetect?.detectedHalf ?? null,
        firstDetectedAtMs: earlyDetect?.detectedAtMs ?? null,
      }).catch(err => console.warn(`[HR_RADAR_CONTACT_UPDATE] persist failed: ${err.message}`));
    }
  }

  async triggerEngine(gameId: string, normalizedStatus: "live" | "pregame" | "final" | "unknown", triggers?: StateChangeTrigger[]): Promise<MLBPropOutput[]> {
    const outputs: MLBPropOutput[] = [];
    const qualifiedSignals: MLBQualifiedSignal[] = [];
    const allSignals: MLBQualifiedSignal[] = [];
    let marketsEvaluated = 0;
    let signalsQualified = 0;
    let signalsRejected = 0;
    let scoreSum = 0;
    let anyDegraded = false;
    // [MLB_PRE_CHANGE_AUDIT] STEP 5 — Feature trace dedup. Loop is
    // market-outer / batter-inner so the same batter is hit ~6× per cycle;
    // log [MLB_FEATURES] only once per batter per triggerEngine invocation.
    const featureLogged = new Set<string>();
    const state = mlbGameCache.gameState[gameId];
    const game = getGame(gameId);

    if (normalizedStatus !== "live") {
      console.log(`[MLB orchestrator] triggerEngine skipped for game ${gameId}: normalizedStatus=${normalizedStatus ?? "undefined"} (must be "live")`);
      return outputs;
    }

    const effectiveDedup = triggers ? this.getDedupWindow(triggers) : DEDUP_WINDOW_MS;
    const last = LAST_RUN.get(gameId);
    if (last !== undefined && Date.now() - last < effectiveDedup) {
      console.log(`[MLB orchestrator] triggerEngine dedup-skipped for game ${gameId} (ran within ${effectiveDedup}ms)`);
      auditRecordCooldown(gameId, Date.now() - last, effectiveDedup);
      return outputs;
    }
    LAST_RUN.set(gameId, Date.now());

    const impactedMarkets = triggers ? this.computeImpactedMarkets(triggers) : new Set(ALL_MLB_MARKETS);
    if (triggers) {
      console.log(`[MLB orchestrator] Event-driven recalc for game ${gameId}: triggers=[${triggers.join(",")}] impactedMarkets=[${Array.from(impactedMarkets).join(",")}]`);
    }

    if (!state) {
      console.warn(`[MLB orchestrator] triggerEngine: no game state cached for ${gameId}`);
      return outputs;
    }
    auditBeginCycle(gameId);

    const contactCache = mlbGameCache.contactData[gameId];
    const pitcherCtxCache = mlbGameCache.pitcherContext[gameId];
    const weatherCache = mlbGameCache.weather[gameId];
    const bullpenCache = mlbGameCache.bullpen[gameId];

    const hourlyWeather = resolveCurrentHourWeather(gameId);
    const resolvedTemp = hourlyWeather?.temperature ?? weatherCache?.temperature ?? null;
    const resolvedWindSpeed = hourlyWeather?.windSpeed ?? weatherCache?.windSpeed ?? null;
    const resolvedWindDir = hourlyWeather?.windDirection ?? weatherCache?.windDirection ?? null;
    const resolvedHumidity = hourlyWeather?.humidity ?? weatherCache?.humidity ?? null;
    const resolvedWindShift = weatherCache?.windShiftDetected ?? false;

    if (weatherCache?.venueName) {
      const _pf = getMarketParkFactor(weatherCache.venueName);
      const _hrF = getMarketParkFactor(weatherCache.venueName, "home_runs");
      const _hitsF = getMarketParkFactor(weatherCache.venueName, "hits");
      console.log(`[MLB_PARK] game=${gameId} venue="${weatherCache.venueName}" overall=${_pf} hr=${_hrF} hits=${_hitsF}${resolvedWindShift ? " WIND_SHIFT" : ""}`);
    }

    // ── Resolve MLB odds event ID once per game ────────────────────────────────
    let oddsEventId: string | null = null;
    if (game) {
      try {
        oddsEventId = await resolveMLBOddsEventId(game.awayTeam, game.homeTeam);
        pLog(gameId, "oddsEventId", { resolved: oddsEventId, home: game.homeTeam, away: game.awayTeam });
      } catch (err: any) {
        console.warn(`[MLB orchestrator] Could not resolve odds event ID for game ${gameId}:`, err.message);
        pLog(gameId, "oddsEventId:error", { error: err.message });
      }
    }

    const batterArchetypeCache = new Map<string, MLBBatterArchetype>();
    let pitcherArch: MLBPitcherArchetype | null = null;

    {
      const activePitcherForArch = state.pitcherInGame;
      if (activePitcherForArch?.playerId) {
        const pStats = mlbPlayerCache.pitcherSeasonStats[activePitcherForArch.playerId];
        if (pStats) {
          const gs = (pStats as any).gamesStarted ?? null;
          const ip = pStats.inningsPitched ?? null;
          pitcherArch = classifyPitcherArchetype({
            era: pStats.era ?? null,
            whip: pStats.whip ?? null,
            kPer9: pStats.kPer9 ?? null,
            inningsPitched: ip,
            gamesStarted: gs,
            avgInningsPerStart: gs != null && gs > 0 && ip != null ? ip / gs : null,
          });
          console.log(`[MLB_ARCHETYPE] pitcher=${activePitcherForArch.playerName} archetype=${pitcherArch} ERA=${pStats.era ?? "?"}`);
        }
      }
    }

    for (const batter of state.battingOrder) {
      if (!batter.playerId || batter.playerId === "unknown") continue;
      const rollingStatsForArch = mlbPlayerCache.batterRollingStats[batter.playerId];
      const contactForArch = contactCache?.byPlayerId?.[batter.playerId];
      const bArch = classifyBatterArchetype({
        xBA: contactForArch?.xBA ?? null,
        barrelRate: contactForArch?.barrelPct != null ? contactForArch.barrelPct / 100 : null,
        exitVelocity: contactForArch?.exitVelocity ?? null,
        battingOrderSlot: batter.slot ?? 5,
        seasonPA: rollingStatsForArch?.last30?.games != null ? rollingStatsForArch.last30.games * 4 : 200,
        seasonOPS: rollingStatsForArch?.seasonOps ?? null,
        last7OPS: rollingStatsForArch?.last7?.ops ?? null,
        last15OPS: rollingStatsForArch?.last15?.ops ?? null,
        platoonGap: null,
        isStarting: true,
      });
      batterArchetypeCache.set(batter.playerId, bArch);
    }

    // Task #126 — HR Presence Floor tracker. Records playerIds for whom a
    // PATH A–E HR-radar row was created/updated this tick (i.e. the engine
    // returned ALERT or WATCH for the home_runs market). Any batter NOT in
    // this set who still meets the cheap power-threat eligibility floor
    // gets a presence-only row written after the markets loop, so a future
    // HR by that batter grades as called_miss (presence-only) instead of
    // uncalled_hr.
    const playersWithRealHrRow = new Set<string>();

    // ── Batter markets: evaluate each hitter in the starting lineup ────────────
    for (const market of BATTER_MARKETS) {
      if (!impactedMarkets.has(market)) continue;
      for (const batter of state.battingOrder) {
        auditRecordRaw(gameId);
        // ── Input validation: skip player if required context is missing ─────
        if (!batter.playerId || batter.playerId === "unknown") {
          console.warn(`[MLB orchestrator] Skipping batter — missing playerId (market: ${market})`);
          auditRecordRejection(gameId, "missingContext", market, "missing_playerId");
          continue;
        }
        if (!batter.slot || batter.slot < 1 || batter.slot > 9) {
          console.warn(`[MLB orchestrator] Skipping ${batter.playerName} — invalid battingOrderSlot: ${batter.slot} (market: ${market})`);
          auditRecordRejection(gameId, "missingContext", market, "invalid_battingOrderSlot");
          continue;
        }
        if (!gameId) {
          console.warn(`[MLB orchestrator] Skipping ${batter.playerName} — missing gameId (market: ${market})`);
          auditRecordRejection(gameId, "missingContext", market, "missing_gameId");
          continue;
        }
        if (!state.inning || state.inning < 1) {
          console.warn(`[MLB orchestrator] Skipping ${batter.playerName} — inning not set: ${state.inning} (market: ${market})`);
          auditRecordRejection(gameId, "missingContext", market, "inning_not_set");
          continue;
        }

        const { remainingPA, remainingAB } = estimateRemainingPA(
          state.inning,
          state.isTopInning,
          batter.slot
        );

        // Contact quality from cache
        const playerContact = contactCache?.byPlayerId?.[batter.playerId];

        // Pitcher context for the active pitcher
        const pitcher = state.pitcherInGame;
        const pitcherCtx = pitcher ? pitcherCtxCache?.byPitcherId?.[pitcher.playerId] : undefined;

        const isPitcherCollapsing = pitcherCtx
          ? (pitcherCtx.velocityDrop !== null && pitcherCtx.velocityDrop > 2)
          : false;

        const managerLeashShort = pitcherCtx
          ? pitcherCtx.timesThroughOrder >= 3 && pitcherCtx.pitchCount > 80
          : false;

        console.log(`[MLB MARKET INPUT][${gameId}][${market}] { playerName: "${batter.playerName}", playerId: "${batter.playerId}", inning: ${state.inning} }`);

        const resolvedLine = await resolveBookLine(oddsEventId, batter.playerName, market);
        let hrRadarOnly = false;
        if (resolvedLine === null) {
          if (market === "home_runs") {
            hrRadarOnly = true;
            console.log(`[MLB HR_RADAR_ONLY][${gameId}] ${batter.playerName} — no book line for home_runs, running HR radar scan only`);
          } else {
            console.log(`[MLB MARKET SKIP][${gameId}][${market}] { playerName: "${batter.playerName}", reason: "no_book_line" }`);
            auditRecordRejection(gameId, "staleOdds", market, "no_book_line_batter");
            continue;
          }
        }
        if (resolvedLine && resolvedLine.isDegraded) anyDegraded = true;

        if (!hrRadarOnly) {
          const resolvedMarketObj = { line: resolvedLine!.line, odds: (resolvedLine!.overOdds !== null || resolvedLine!.underOdds !== null) ? { overOdds: resolvedLine!.overOdds, underOdds: resolvedLine!.underOdds } : null };
          if (!hasRealOdds(resolvedMarketObj)) {
            console.warn(`[MLB orchestrator] hasRealOdds failed for ${batter.playerName}/${market} — signalLocked=false, skipping computation`);
            console.log(`[MLB MARKET SKIP][${gameId}][${market}] { playerName: "${batter.playerName}", reason: "no_real_odds", line: ${resolvedLine!.line} }`);
            auditRecordRejection(gameId, "staleOdds", market, "no_real_odds_batter");
            continue;
          }
        }
        auditRecordNormalized(gameId, market);

        const boxScorePlayer = mlbGameCache.gameBoxScore[gameId]?.byPlayerId?.[batter.playerId];
        const playerAB = boxScorePlayer?.ab ?? 0;
        const isEarlySignalMode = playerAB < 1;

        const rollingStats = mlbPlayerCache.batterRollingStats[batter.playerId];
        const pitcherSeasonStats = pitcher ? mlbPlayerCache.pitcherSeasonStats[pitcher.playerId] : undefined;
        const bvpKey = pitcher ? `${batter.playerId}_vs_${pitcher.playerId}` : null;
        const bvpData = bvpKey ? mlbPlayerCache.bvpMatchups[bvpKey] : undefined;

        const batterSeasonAvg = rollingStats?.seasonAvg ?? 0.250;
        const rollingAvg = rollingStats?.last15?.avg;
        const rawSeasonAvg = rollingAvg != null ? rollingAvg : batterSeasonAvg;
        const rateAdj = getLearnedRateAdjustment(market);
        const effectiveSeasonAvg = rateAdj !== 1.0
          ? Math.max(0.01, rawSeasonAvg * rateAdj)
          : rawSeasonAvg;
        let currentStatForMarket = 0;
        if (boxScorePlayer) {
          switch (market) {
            case "hits": currentStatForMarket = boxScorePlayer.hits; break;
            case "home_runs": currentStatForMarket = boxScorePlayer.hr; break;
            case "hrr": currentStatForMarket = (boxScorePlayer.hr ?? 0) + ((boxScorePlayer as any).r ?? 0) + ((boxScorePlayer as any).rbi ?? 0); break;
            case "total_bases": currentStatForMarket = boxScorePlayer.tb; break;
            case "pitcher_strikeouts": case "hits_allowed": currentStatForMarket = 0; break;
            default: currentStatForMarket = boxScorePlayer.hits; break;
          }
        }

        // MLB Signals audit P1 — race-proof currentStat for ALL batter markets.
        // The play feed updates priorABResults synchronously inside
        // syncContactData, before the box-score has refreshed counts. Take the
        // max of (box-score, play-feed) so the engine sees the freshest value
        // possible and `alreadyHit` flips the moment the resolving play lands.
        // Pre-existing `[MLB CONTACT_CROSSCHECK]` log preserved for hits so
        // existing log consumers are unchanged; new `[MLB PLAYFEED_OVERRIDE]`
        // covers the additional markets.
        const playFeedStat = getPlayFeedBatterStatCount(gameId, batter.playerId, market);
        if (playFeedStat > currentStatForMarket) {
          if (market === "hits") {
            console.log(`[MLB CONTACT_CROSSCHECK][${gameId}] ${batter.playerName} hits: box=${currentStatForMarket} contact=${playFeedStat} — using contact`);
          } else {
            console.log(`[MLB PLAYFEED_OVERRIDE][${gameId}] ${batter.playerName} ${market}: box=${currentStatForMarket} playFeed=${playFeedStat} — using play feed`);
          }
          currentStatForMarket = playFeedStat;
        }
        // Stamp the resolved-set the moment the play-feed-derived count
        // crosses the prop line. Idempotent — only logs the first crossing.
        if (!hrRadarOnly && resolvedLine && resolvedLine.line > 0) {
          maybeMarkNonHrResolved(
            gameId,
            batter.playerId,
            batter.playerName,
            market,
            resolvedLine.line,
            playFeedStat
          );
        }

        const boxHR = boxScorePlayer?.hr ?? 0;
        const currentGameHR = boxHR;
        // Note: HR grading is now centralized in gradeHomeRunsFromPlays()
        // (called once per poll cycle from _pollGameInner) using the canonical
        // inning/halfInning from each HR play's about.* fields. The legacy
        // box-score-driven path used state.inning here, which produced wrong
        // inning attribution when polling lagged behind an inning rollover.
        const hardHitCount = playerContact
          ? (playerContact.priorABResults ?? []).filter((ab: any) => (ab.exitVelocity ?? 0) >= 95).length
          : 0;

        const rosterLookup = getPlayer(batter.playerId);
        const resolvedBatterHand: "L" | "R" | "S" | null = rosterLookup?.bats ?? null;
        const batterOpponent = state.homeTeamAbbr && state.awayTeamAbbr
          ? (batter.team === state.homeTeamAbbr ? state.awayTeamAbbr : state.homeTeamAbbr)
          : "";

        const input: MLBPropInput = {
          playerId: batter.playerId,
          playerName: batter.playerName,
          team: batter.team,
          opponent: batterOpponent,
          gameId,
          market,
          bookLine: hrRadarOnly ? 0.5 : resolvedLine!.line,
          overOdds: hrRadarOnly ? null : resolvedLine!.overOdds,
          underOdds: hrRadarOnly ? null : resolvedLine!.underOdds,
          seasonAvg: effectiveSeasonAvg,
          plateAppearances: state.pitchCount > 0 ? Math.max(1, state.battingOrder.length) : 0,
          atBats: boxScorePlayer ? boxScorePlayer.ab : Math.max(0, state.pitchCount > 0 ? Math.max(1, state.battingOrder.length) : 0),
          currentStatValue: currentStatForMarket,
          remainingPA,
          remainingAB,
          completedAB: boxScorePlayer ? boxScorePlayer.ab : Math.max(0, 4 - remainingAB),
          inning: state.inning,
          isTopInning: state.isTopInning,
          currentGameHR,
          hardHitCount,
          batterHand: rosterLookup?.bats ?? null,
          contactQuality: (() => {
            const ev = playerContact?.exitVelocity ?? null;
            const la = playerContact?.launchAngle ?? null;
            const dist = playerContact?.hitDistance ?? null;
            const learnedScores = ev != null ? getContactQualityScore(ev, la, dist) : null;
            const latestPitchType = (playerContact?.priorABResults ?? []).slice(-1)[0]?.pitchType ?? null;
            const pitchHrRisk = latestPitchType ? getPitchTypeHrRisk(latestPitchType) : null;
            return {
              exitVelocity: ev,
              launchAngle: la,
              hitDistance: dist,
              hardHitRateSeason: playerContact?.hardHitPct != null ? playerContact.hardHitPct / 100 : null,
              barrelRateProxySeason: playerContact?.barrelPct != null ? playerContact.barrelPct / 100 : null,
              avgBatSpeed: playerContact?.avgBatSpeed ?? null,
              avgSwingLength: playerContact?.avgSwingLength ?? null,
              priorABResults: (playerContact?.priorABResults ?? []) as MLBPropInput["contactQuality"]["priorABResults"],
              xBA: playerContact?.xBA ?? null,
              xSLG: playerContact?.xSLG ?? null,
              learnedHitLikelihood: learnedScores?.hitLikelihood ?? null,
              learnedHrLikelihood: learnedScores?.hrLikelihood ?? null,
              pitchTypeHrRisk: pitchHrRisk,
            };
          })(),
          pitcher: {
            pitchCount: pitcher ? state.pitchCount : 0,
            timesThrough: pitcherCtx?.timesThroughOrder ?? 1,
            era: pitcherSeasonStats?.era ?? null,
            whip: pitcherSeasonStats?.whip ?? null,
            kPer9: pitcherSeasonStats?.kPer9 ?? null,
            bbPer9: pitcherSeasonStats?.bbPer9 ?? null,
            managerLeashShort,
            isPitcherCollapsing,
            pitchMix: pitcherCtx?.pitchMix ?? [],
            throws: pitcher?.throws ?? null,
            seasonAvgVelocity: pitcherCtx?.seasonAvgVelocity ?? null,
          },
          ...(market === "hrr" && boxScorePlayer ? {
            hrrComponents: {
              currentHits: boxScorePlayer.hits ?? 0,
              currentRuns: (boxScorePlayer as any).r ?? 0,
              currentRBIs: (boxScorePlayer as any).rbi ?? 0,
              hitsRate: effectiveSeasonAvg,
              runsRate: 0.10,
              rbisRate: 0.12,
            },
          } : {}),
          ...(bvpData && bvpData.atBats > 0 ? {
            bvpHistory: {
              atBats: bvpData.atBats,
              hits: bvpData.hits,
              homeRuns: bvpData.homeRuns,
              strikeouts: bvpData.strikeouts,
              avg: bvpData.avg,
            },
          } : {}),
          ...(rollingStats ? {
            rollingForm: {
              last7Avg: rollingStats.last7.avg,
              last15Avg: rollingStats.last15.avg,
              last30Avg: rollingStats.last30.avg,
              last7Ops: rollingStats.last7.ops,
              last15Ops: rollingStats.last15.ops,
            },
            hrTrend: {
              abSinceLastHR: rollingStats.abSinceLastHR,
              hrRateLast7: rollingStats.hrRateLast7,
              hrRateLast15: rollingStats.hrRateLast15,
              hrRateLast30: rollingStats.hrRateLast30,
              seasonTotalHR: rollingStats.seasonTotalHR,
              seasonTotalAB: rollingStats.seasonTotalAB,
            },
          } : {}),
          lineup: {
            battingOrderSlot: batter.slot,
            orderTurnoverProximity: 0.5,
            lineupSectionStrength: batter.slot <= 3 ? "strong" : batter.slot <= 6 ? "neutral" : "weak",
            hittersAheadOnBase: state.runnersOnBase.length,
            pocketWeakness: null,
          },
          weatherPark: {
            parkFactor: getMarketParkFactor(weatherCache?.venueName, market, resolvedBatterHand),
            temperature: resolvedTemp,
            windSpeed: resolvedWindSpeed,
            windDirection: resolvedWindDir,
            humidity: resolvedHumidity,
            isIndoors: weatherCache?.isIndoors ?? isVenueIndoors(weatherCache?.venueName),
            parkHistoryFactor: null,
            windShiftDetected: resolvedWindShift,
          },
          bullpen: {
            bullpenEra: bullpenCache?.bullpenEra ?? null,
            bullpenUsageLastThreeDays: bullpenCache?.bullpenUsageLastThreeDays ?? null,
            isTopRelieverAvailable: bullpenCache?.isTopRelieverAvailable ?? true,
          },
        };

        if (market === "home_runs" || market === "hrr") {
          const ohData = getOnlyHomersEnrichment(batter.playerName);
          if (ohData.isHotHitter) {
            const boost = ohData.hotHitterPeriod === "7d" ? 0.8 : ohData.hotHitterPeriod === "14d" ? 0.5 : 0.3;
            input.hotHitterBoost = boost;
          }
          // Gap 3: pre-game pitcher fatigue for HR/HRR markets
          if (pitcherCtx) {
            input.pitcherEntryFatigue = {
              lastStartPitchCount: pitcherCtx.lastStartPitchCount ?? null,
              daysSinceLastStart: pitcherCtx.daysSinceLastStart ?? null,
              last3StartERA: pitcherCtx.last3StartERA ?? null,
            };
          }
        }

        input.liveInterpretation = buildLiveEventInterpretation(input);

        // [MLB_PRE_CHANGE_AUDIT] STEP 5 — Feature presence + values trace.
        // Confirms BvP / weather / handedness / park / archetype data is
        // actually reaching the engine input (not just shown in the UI).
        // Once per batter per triggerEngine cycle (loop is market-outer).
        if (!featureLogged.has(batter.playerId)) {
          featureLogged.add(batter.playerId);
          const bArchForLog = batterArchetypeCache.get(batter.playerId) ?? null;
          console.log(`[MLB_FEATURES] ${JSON.stringify({
            gameId,
            player: batter.playerName,
            playerId: batter.playerId,
            hasBvp: !!(bvpData && bvpData.atBats > 0),
            bvpScore: bvpData ? { atBats: bvpData.atBats, hits: bvpData.hits, hr: bvpData.homeRuns, k: bvpData.strikeouts, avg: bvpData.avg } : null,
            hasWeather: !!(resolvedTemp != null || resolvedWindSpeed != null || weatherCache?.venueName),
            weather: { temp: resolvedTemp, windSpeed: resolvedWindSpeed, windDir: resolvedWindDir, humidity: resolvedHumidity, indoors: weatherCache?.isIndoors ?? null, venue: weatherCache?.venueName ?? null, windShift: resolvedWindShift },
            hasHandedness: !!(rosterLookup?.bats || pitcher?.throws),
            handedness: { batterHand: rosterLookup?.bats ?? null, pitcherThrows: pitcher?.throws ?? null, resolved: resolvedBatterHand ?? null },
            parkFactor: input.weatherPark.parkFactor,
            batterArchetype: bArchForLog,
            pitcherArchetype: pitcherArch ?? null,
            hasRollingForm: !!rollingStats,
            hasBoxScore: !!boxScorePlayer,
          })}`);
        }

        pLog(gameId, "engineInput", { player: input.playerName, market: input.market, bookLine: input.bookLine, inning: input.inning, parkFactor: input.weatherPark.parkFactor, venue: weatherCache?.venueName });

        const qualityLayers = {
          parkFactor: weatherCache?.venueName != null,
          weather: weatherCache?.temperature != null,
          pitcherERA: input.pitcher.era != null,
          pitcherWHIP: input.pitcher.whip != null,
          contactEV: input.contactQuality.exitVelocity != null,
          xBA: input.contactQuality.xBA != null,
          xSLG: input.contactQuality.xSLG != null,
          bvp: !!(input as any).bvpHistory,
          rollingForm: !!(input as any).rollingForm,
          bullpen: bullpenCache?.bullpenEra != null,
        };
        const realCount = Object.values(qualityLayers).filter(Boolean).length;
        const isDegraded = realCount <= 5;
        if (isDegraded) {
          console.warn(`[MLB_INPUT_QUALITY] DEGRADED game=${gameId} player=${input.playerName} market=${market} real=${realCount}/10 layers=${JSON.stringify(qualityLayers)}`);
        }
        (input as any).isDegraded = isDegraded;

        const guardError = validateMLBInput(input);
        if (guardError) {
          console.warn(`[MLB orchestrator] Skipping ${batter.playerName}/${market}: ${guardError}`);
          console.log(`[MLB MARKET SKIP][${gameId}][${market}] { playerName: "${batter.playerName}", reason: "guard_error:${guardError}" }`);
          continue;
        }

        // ── Structured per-player input log ────────────────────────────────
        console.log(`[MLB engine:input] ${JSON.stringify({
          playerId: batter.playerId,
          playerContext: {
            gameId,
            battingOrderSlot: batter.slot,
            inning: state.inning,
            isTopInning: state.isTopInning,
            currentStats: {
              ab: input.atBats,
              h: input.currentStatValue,
              remainingPA,
            },
            pitcherContext: {
              pitchCount: input.pitcher.pitchCount,
              timesThrough: input.pitcher.timesThrough,
              isPitcherCollapsing: input.pitcher.isPitcherCollapsing,
            },
            parkFactor: input.weatherPark.parkFactor,
          },
          bookLine: input.bookLine,
          market,
        })}`);

        try {
          const rawOutput = calculateMLBPropEdge(input);
          if (!hrRadarOnly) marketsEvaluated++;

          const fwResult = runIntegrityFirewall(rawOutput);
          logFirewallResult(gameId, rawOutput.playerName, market, fwResult);

          if (fwResult.hardReject && !hrRadarOnly) {
            signalsRejected++;
            console.log(`[MLB MARKET SKIP][${gameId}][${market}] { playerName: "${batter.playerName}", reason: "firewall_hard_reject" }`);
            auditRecordRejection(gameId, "marketValidation", market, "firewall_hard_reject_batter");
            continue;
          }

          const output = fwResult.hardReject ? rawOutput : fwResult.cappedOutput;

          const bArch = batterArchetypeCache.get(batter.playerId) ?? "stable_regular";

          // Trace: engine → firewall → final (no double-cap; engine is authoritative)
          console.log(`[MLB_PROB_TRACE] player=${batter.playerName} market=${market} arch=${bArch} engine=${rawOutput.calibratedProbability.toFixed(1)} postFw=${output.calibratedProbability.toFixed(1)} side=${output.recommendedSide} edge=${output.edge.toFixed(2)}`);

          if (output.recommendedSide === "OVER" || output.recommendedSide === "UNDER") {
            trackSignalDirection(market, output.recommendedSide);
          }

          const bvpAvg = bvpData?.avg ?? null;
          const thesis = generateThesis(
            bArch,
            pitcherArch,
            market,
            output.recommendedSide === "OVER" || output.recommendedSide === "UNDER" ? output.recommendedSide : "OVER",
            [],
            input.weatherPark.parkFactor,
            bvpAvg,
            output.formIndicator ?? null,
            input.pitcher.pitchCount,
            input.pitcher.timesThrough,
            input.weatherPark.windDirection ?? null
          );

          pLog(gameId, "engineOutput", { player: output.playerName, market: output.market, edge: output.edge, tier: output.confidenceTier, suppressed: output.suppressed, archetype: bArch });
          recordMLBDiagnostic(output);

          console.log(`[MLB engine] playerId=${batter.playerId} player="${batter.playerName}" market=${market} slot=${batter.slot} inning=${state.inning} remainingPA=${remainingPA} calibratedProbOver=${output.calibratedProbabilityOver.toFixed(2)} calibratedProbUnder=${output.calibratedProbabilityUnder.toFixed(2)} edge=${output.edge.toFixed(2)} side=${output.recommendedSide} arch=${bArch}`);

          outputs.push({ ...output });

          const batterStats = boxScorePlayer ? {
            ab: boxScorePlayer.ab, h: boxScorePlayer.hits, hr: boxScorePlayer.hr,
            tb: boxScorePlayer.tb, bb: boxScorePlayer.bb, rbi: boxScorePlayer.rbi,
            k: boxScorePlayer.so, sb: 0,
          } : null;

          const lastAB = playerContact?.priorABResults?.length
            ? playerContact.priorABResults[playerContact.priorABResults.length - 1]
            : null;
          const lastABContact = lastAB || playerContact ? {
            exitVelo: lastAB?.exitVelocity ?? playerContact?.exitVelocity ?? null,
            launchAngle: lastAB?.launchAngle ?? playerContact?.launchAngle ?? null,
            batSpeed: playerContact?.avgBatSpeed ?? null,
            distance: lastAB?.distance ?? playerContact?.hitDistance ?? null,
            barrelPct: playerContact?.barrelPct ?? null,
            hardHitPct: playerContact?.hardHitPct ?? null,
            outcome: lastAB?.outcome ?? null,
            perABxBA: lastAB?.perABxBA ?? null,
            contactGrade: lastAB?.contactGrade ?? undefined,
            hrProbability: lastAB?.hrProbability ?? 0,
          } : null;

          if (!hrRadarOnly) {
            const qResult = this.qualifySignal(gameId, input, output);
            if (qResult && !isEarlySignalMode) {
              qResult.currentStats = batterStats;
              qResult.lastABContact = lastABContact;
              qResult.batterArchetype = bArch;
              qResult.pitcherArchetype = pitcherArch;
              qResult.thesis = thesis;
              qResult.safetyCeilingApplied = output.safetyCeilingApplied ?? false;
              qResult.varianceTier = MARKET_VOLATILITY[market] ?? "mid";
              qResult.isDegraded = !!(input as any).isDegraded;
              if ((input as any).bvpHistory) {
                qResult.bvpHistory = (input as any).bvpHistory;
              }
              qResult.dataQuality = !!(input as any).isDegraded ? "degraded" : (Object.values({
                parkFactor: weatherCache?.venueName != null,
                weather: weatherCache?.temperature != null,
                pitcherERA: input.pitcher.era != null,
                xBA: input.contactQuality.xBA != null,
                bvp: !!bvpData,
              }).filter(Boolean).length >= 4 ? "full" : "partial");
              qualifiedSignals.push(qResult);
              allSignals.push(qResult);
              signalsQualified++;
              scoreSum += qResult.signalScore;
              auditRecordQualified(gameId, {
                market: qResult.market,
                probability: qResult.engineProbability ?? 0,
                signalScore: qResult.signalScore ?? 0,
                edge: (qResult as any).edge ?? 0,
                isHrWatch: (qResult.signalTags ?? []).some((t: string) => /hr_watch|hr_radar/i.test(t)),
              });
            } else {
              if (!isEarlySignalMode) signalsRejected++;
              const watchSig = isEarlySignalMode
                ? (qResult ?? this.buildWatchSignal(gameId, input, output))
                : this.buildWatchSignal(gameId, input, output);
              if (watchSig) {
                auditRecordWatchSurfaced(gameId, market);
                watchSig.currentStats = batterStats;
                watchSig.lastABContact = lastABContact;
                watchSig.batterArchetype = bArch;
                watchSig.pitcherArchetype = pitcherArch;
                watchSig.thesis = thesis;
                watchSig.isDegraded = !!(input as any).isDegraded;
                if ((input as any).bvpHistory) {
                  watchSig.bvpHistory = (input as any).bvpHistory;
                }
                if (isEarlySignalMode) {
                  watchSig.confidenceTier = "WATCHLIST" as any;
                  watchSig.isEarlySignal = true;
                  watchSig.watchlist = true;
                  watchSig.actionable = false;
                  console.log(`[MLB EARLY_SIGNAL] ${batter.playerName}/${market} game=${gameId} — pre-AB watchlist signal (edge=${output.edge.toFixed(1)}, side=${output.recommendedSide})`);
                }
                allSignals.push(watchSig);
              }
            }
          }

          if (market === "home_runs" && output.hrBuildScore != null && output.hrBuildScore > 0) {
            const hrFactorsBuild = typeof output.hrFactors === "object" && output.hrFactors?.build
              ? output.hrFactors.build
              : { avgEV: null, maxEV: null, avgLA: null, barrels: 0, hardHits: 0, deepFlyouts: 0, batSpeedScore: 0, pitcherFatigueBoost: 0, parkWindBoost: 0, platoonBoost: 0, hrShapedCount: 0, missedHrCount: 0, eliteHrCount: 0, qualifiedEVMean: null, maxDistance: null, contactClasses: [] };

            const isReliever = bullpenCache?.relieversUsed?.some(
              r => r.playerId === pitcher?.playerId
            ) ?? false;
            let relieverEra: number | null = null;
            if (isReliever && pitcher?.playerId) {
              relieverEra = pitcherSeasonStats?.era ?? null;
            }

            let starterEra: number | null = null;
            if (isReliever && pitcherCtxCache?.byPitcherId && pitcher?.team) {
              const allPitcherIds = Object.keys(pitcherCtxCache.byPitcherId);
              const relieverIds = new Set(
                (bullpenCache?.relieversUsed ?? []).map(r => r.playerId)
              );
              for (const pid of allPitcherIds) {
                if (pid === pitcher.playerId) continue;
                if (relieverIds.has(pid)) continue;
                const sStats = mlbPlayerCache.pitcherSeasonStats[pid];
                if (sStats?.era != null) {
                  starterEra = sStats.era;
                  break;
                }
              }
            }

            const pitcherDeteriorationCtx = {
              velocityDrop: pitcherCtx?.velocityDrop ?? null,
              avgVelocity: pitcherCtx?.avgVelocity ?? null,
              seasonAvgVelocity: pitcherCtx?.seasonAvgVelocity ?? null,
              isReliever,
              relieverEra,
              starterEra: isReliever ? starterEra : (pitcherSeasonStats?.era ?? null),
              bullpenEra: bullpenCache?.bullpenEra ?? null,
              bullpenUsageLast3Days: bullpenCache?.bullpenUsageLastThreeDays ?? null,
              relieversUsedCount: bullpenCache?.relieversUsed?.length ?? 0,
            };

            const resolvedSeasonHRRate = rollingStats?.seasonHRRate ?? null;
            const resolvedOpponent = state.homeTeamAbbr && state.awayTeamAbbr
              ? (batter.team === state.homeTeamAbbr ? state.awayTeamAbbr : state.homeTeamAbbr)
              : "";

            const alertInput: HRAlertInput = {
              playerId: batter.playerId,
              playerName: batter.playerName,
              teamAbbr: batter.team,
              gameId,
              hrBuildScore: output.hrBuildScore,
              hrIntensity: output.hrIntensity ?? "weak",
              factors: hrFactorsBuild as any,
              inning: state.inning,
              isTopInning: state.isTopInning,
              battingOrderSlot: batter.slot,
              remainingPA,
              pitchCount: pitcher ? state.pitchCount : 0,
              timesThrough: pitcherCtx?.timesThroughOrder ?? 1,
              isPitcherCollapsing,
              parkFactor: getMarketParkFactor(weatherCache?.venueName, "home_runs", resolvedBatterHand),
              windDirection: resolvedWindDir,
              windSpeed: resolvedWindSpeed,
              temperature: resolvedTemp,
              isIndoors: weatherCache?.isIndoors ?? isVenueIndoors(weatherCache?.venueName),
              batterHand: resolvedBatterHand,
              pitcherThrows: pitcher?.throws ?? null,
              era: pitcherSeasonStats?.era ?? null,
              currentRuns: (state.homeScore != null || state.awayScore != null)
                ? (state.homeScore ?? 0) + (state.awayScore ?? 0)
                : 4.5,
              leagueAvgRuns: 4.5,
              seasonHRRate: resolvedSeasonHRRate,
              barrelRate: playerContact?.barrelPct != null ? playerContact.barrelPct / 100 : null,
              hardHitRate: playerContact?.hardHitPct != null ? playerContact.hardHitPct / 100 : null,
              xSLG: playerContact?.xSLG ?? null,
              abSinceLastHR: rollingStats?.abSinceLastHR ?? null,
              hrRateLast7: rollingStats?.hrRateLast7 ?? null,
              hrRateLast15: rollingStats?.hrRateLast15 ?? null,
              hrRateLast30: rollingStats?.hrRateLast30 ?? null,
              handednessParkFactor: getMarketParkFactor(weatherCache?.venueName, "home_runs", resolvedBatterHand),
              pitcherDeterioration: pitcherDeteriorationCtx,
              leiNearHrScore: input.liveInterpretation?.nearHrScore,
              leiMomentumScore: input.liveInterpretation?.momentumScore,
              leiPitcherFatigueScore: input.liveInterpretation?.pitcherFatigueScore,
              leiVeloDropScore: input.liveInterpretation?.veloDropScore,
              leiConfidenceBoost: input.liveInterpretation?.confidenceBoost,
              leiTags: input.liveInterpretation?.tags,
              priorABResults: (playerContact?.priorABResults ?? []).map((ab: any) => ({
                exitVelocity: ab.exitVelocity ?? null,
                launchAngle: ab.launchAngle ?? null,
                distance: ab.distance ?? null,
                outcome: ab.outcome ?? "out",
              })),
              preHrDangerScore: (output.hrFactors as any)?.preHrDangerScore,
              dangerFlags: (output.hrFactors as any)?.dangerFlags,
              // Phase 3 — pass batter archetype so evaluateHRAlert can ease
              // tier 4c promotion for elite_power profiles. Cache lookup is
              // already done above in this try block.
              batterArchetype: bArch,
            };
            const alertResult = evaluateHRAlert(alertInput);

            const hrDynSnap = recomputeHrAlertState(alertInput, {
              gameFinal: (normalizedStatus as string) === "final",
              currentPitcherId: pitcher?.playerId ?? null,
              isHome: batter.team === state.homeTeamAbbr,
              precomputedAlert: alertResult,
            });
            (output as any).hrAlertSnapshot = hrDynSnap;
            console.log(`[HR_DYNAMIC] ${batter.playerName} state=${hrDynSnap.currentState} readiness=${hrDynSnap.hrReadinessScore} convRaw=${(hrDynSnap.hrConversionProbabilityRaw * 100).toFixed(1)}% convCal=${(hrDynSnap.hrConversionProbabilityCalibrated * 100).toFixed(1)}% decay=${hrDynSnap.decayFactor.toFixed(2)} pitVuln=${hrDynSnap.pitcherHrVulnerability} remPA=${hrDynSnap.remainingPAExpectation.toFixed(1)} tick=${hrDynSnap.tickCount} game=${gameId}`);

            const convResult = alertResult.diagnostics.hrConversion;
            const rawPct = convResult ? `${(convResult.hrConversionProbability * 100).toFixed(1)}%` : "n/a";
            const calPct = convResult ? `${(convResult.calibratedProbability * 100).toFixed(1)}%` : "n/a";
            const detState = convResult?.pitcherDeteriorationState ?? "n/a";
            if (alertResult.level === "ALERT" || alertResult.level === "WATCH") {
              const diag = alertResult.diagnostics;
              console.log(`[HR_ALERT_TRIGGER] ${alertResult.level} ${batter.playerName} score=${output.hrBuildScore} rawConv=${rawPct} calConv=${calPct} pitDet=${detState} reason=${alertResult.triggerReason} state=${alertResult.signalState} decision=${alertResult.decision} confidence=${alertResult.confidenceScore} tier=${alertResult.alertTier} path=${diag.alertPath} hrShaped=${diag.hrShapedCount} missed=${diag.missedHrCount} elite=${diag.eliteHrCount} evMean=${diag.qualifiedEVMean} maxDist=${diag.maxDistance} remPA=${diag.remainingPA} pitcher=${diag.pitcherFatigueState} env=${diag.environmentContext} suppressions=${diag.suppressionFlags.length} positives=[${diag.positiveFactors.join("|")}] game=${gameId} inn=${state.inning}`);
              // Only burn the 10-minute cooldown on actual ALERTs. WATCH-tier
              // signals (FORMATION/MONITOR) are non-actionable tracking signals
              // and must not suppress a later genuine ALERT for the same
              // player — particularly important for the PATH_E_CONVICTION
              // safety net which intentionally fires WATCH signals before
              // contact-event evidence accumulates.
              if (alertResult.level === "ALERT") {
                markAlertSent(batter.playerId, gameId);
              }
              storage.insertAlert({
                playerId: batter.playerId,
                playerName: batter.playerName,
                teamAbbr: batter.team,
                gameId,
                alertType: alertResult.level === "ALERT" ? "HR_EARLY" : "HR_WATCH",
                triggerReason: alertResult.triggerReason,
                hrBuildScore: output.hrBuildScore,
                hrIntensity: output.hrIntensity ?? "weak",
                inning: state.inning,
                factors: JSON.stringify(hrFactorsBuild),
              }).catch(err => console.warn(`[HR_ALERT] persist failed: ${err.message}`));

              const tierMap: Record<string, "monitor" | "building" | "strong"> = {
                FORMATION: "monitor",
                BUILDING: "building",
                PEAK: "strong",
                COOLDOWN: "monitor",
              };
              const stateMap: Record<string, "live" | "watching" | "actionable"> = {
                FORMATION: "watching",
                BUILDING: "live",
                PEAK: "actionable",
                COOLDOWN: "watching",
              };

              const lastAB = (playerContact?.priorABResults ?? []).slice(-1)[0] as any;
              const contactSnap = lastAB ? {
                ev: lastAB.exitVelocity ?? null,
                la: lastAB.launchAngle ?? null,
                distance: lastAB.distance ?? null,
                hardHit: (lastAB.exitVelocity ?? 0) >= 95,
                barrel: (lastAB.exitVelocity ?? 0) >= 98 && (lastAB.launchAngle ?? 0) >= 20 && (lastAB.launchAngle ?? 0) <= 35,
              } : null;

              const convSnap = alertResult.diagnostics?.hrConversion ? {
                hrConversionProbability: alertResult.diagnostics.hrConversion.hrConversionProbability,
                calibratedProbability: alertResult.diagnostics.hrConversion.calibratedProbability,
                perPAHRRate: alertResult.diagnostics.hrConversion.perPAHRRate,
                expectedRemainingPA: alertResult.diagnostics.hrConversion.expectedRemainingPA,
                liveContactMultiplier: alertResult.diagnostics.hrConversion.liveContactMultiplier,
                pitcherMultiplier: alertResult.diagnostics.hrConversion.pitcherMultiplier,
                environmentMultiplier: alertResult.diagnostics.hrConversion.environmentMultiplier,
                pitcherDeteriorationState: alertResult.diagnostics.hrConversion.pitcherDeteriorationState,
              } : null;

              const diagSnap = alertResult.diagnostics ? {
                alertPath: alertResult.diagnostics.alertPath,
                positiveFactors: alertResult.diagnostics.positiveFactors,
                suppressionFlags: alertResult.diagnostics.suppressionFlags,
                hrShapedCount: alertResult.diagnostics.hrShapedCount,
                missedHrCount: alertResult.diagnostics.missedHrCount,
                eliteHrCount: alertResult.diagnostics.eliteHrCount,
                qualifiedEVMean: alertResult.diagnostics.qualifiedEVMean,
                maxDistance: alertResult.diagnostics.maxDistance,
                remainingPA: alertResult.diagnostics.remainingPA,
                pitcherFatigueState: alertResult.diagnostics.pitcherFatigueState,
                environmentContext: alertResult.diagnostics.environmentContext,
                hrConversion: convSnap,
                confidenceScore: alertResult.confidenceScore,
                contactClasses: alertResult.diagnostics.contactClasses.map(c => ({
                  contactClass: c.contactClass, exitVelocity: c.exitVelocity,
                  launchAngle: c.launchAngle, distance: c.distance,
                  outcome: c.outcome, isBarrel: c.isBarrel,
                })),
                pitcherHrVulnerability: hrDynSnap?.pitcherHrVulnerability ?? null,
              } : null;

              // ── Goldmaster Phase 5: unified canonical stage ──────────────
              // The engine snapshot now produces ONE canonical stage that
              // already merges (a) the dynamic state machine's
              // BET_NOW/PREPARE/WATCH derivation and (b) the PATH evaluator's
              // PEAK/BUILDING override. Terminal-closed and cooling/building
              // peer rules are baked into `computeUnifiedCanonicalStage` in
              // `hrAlertEngine.ts`, so we just read `snapshot.canonicalStage`.
              const canonicalDynamicStage = hrDynSnap ? mapDynamicStateToStage(hrDynSnap.currentState) : null;
              const canonicalStage = hrDynSnap?.canonicalStage ?? canonicalDynamicStage;
              // Goldmaster Phase 1, 3, 7 — AB context for the user-facing card.
              const enginePaCount = (playerContact?.priorABResults ?? []).length;
              const engineHasLiveAB = contactSnap !== null;

              storage.createOrUpdateHrRadarAlert({
                gameId,
                playerId: batter.playerId,
                playerName: batter.playerName,
                team: batter.team,
                opponent: resolvedOpponent,
                inning: state.inning,
                half: state.isTopInning ? "top" : "bottom",
                readinessScore: output.hrBuildScore,
                // Phase 2 — dynamic engine readiness becomes the live progression score
                dynamicReadinessScore: hrDynSnap?.hrReadinessScore ?? null,
                // Phase 1 — canonical stage (overrides legacy sticky tier)
                canonicalStage,
                // Task #140 — raw dynamic state (BET_NOW/PREPARE/etc.) so the
                // user-stage layer can authoritatively read engine state from
                // stageContract.dynamicState rather than re-deriving it.
                dynamicState: hrDynSnap?.currentState ?? null,
                plateAppearancesTracked: enginePaCount,
                hasLiveABContext: engineHasLiveAB,
                confidenceTier: tierMap[alertResult.signalState ?? "FORMATION"] ?? "monitor",
                signalState: stateMap[alertResult.signalState ?? "FORMATION"] ?? "live",
                triggerTags: alertResult.triggerReason ? alertResult.triggerReason.split(", ") : [],
                summaryText: alertResult.formattedReason || `${alertResult.decision} — ${alertResult.triggerReason}`,
                contactSnapshot: contactSnap,
                alertPath: alertResult.diagnostics?.alertPath ?? null,
                alertTier: alertResult.alertTier ?? null,
                diagnosticsSnapshot: diagSnap,
                // Canonical HR score contract (Phase 3)
                buildScore: output.hrBuildScore ?? null,
                conversionProbabilityRaw: alertResult.diagnostics?.hrConversion?.hrConversionProbability ?? null,
                conversionProbability: alertResult.diagnostics?.hrConversion?.calibratedProbability ?? null,
                peakConversionProbability: hrDynSnap?.peakConversionProbability ?? null,
                // Engine's earliest in-memory detection (T002 backfill).
                firstDetectedInning: hrDynSnap?.detectedInning ?? null,
                firstDetectedHalf: hrDynSnap?.detectedHalf ?? null,
                firstDetectedAtMs: hrDynSnap?.detectedAtMs ?? null,
              }).catch(err => console.warn(`[HR_RADAR_ALERT] persist failed: ${err.message}`));
              // Task #126 — record that PATH A–E (or PATH_E_CONVICTION) wrote
              // a real HR-radar row for this player; the presence-floor pass
              // below must skip them so a real row is never downgraded.
              playersWithRealHrRow.add(batter.playerId);
            }
          }
        } catch (err: any) {
          console.warn(`[MLB orchestrator] engine error for ${batter.playerName} / ${market}:`, err.message);
          console.log(`[MLB MARKET SKIP][${gameId}][${market}] { playerName: "${batter.playerName}", reason: "engine_error:${(err as any).message}" }`);
        }
      }
    }

    // ── Task #126: HR Presence Floor pass ───────────────────────────────────
    // Eligibility thresholds. Defaults validated by Task #128 against the
    // 2026-04-04..2026-04-23 window — see `scripts/backtestPresenceFloor.ts`
    // for the sweep harness. Re-run after each fortnight of live data to
    // confirm the noise/coverage trade-off has not drifted.
    // Walk the batting order one more time (cheap — pure cache reads) and
    // surface any plausible power-threat batter who DID NOT receive a real
    // PATH A–E HR-radar row this tick. The presence-only row is created in
    // the WATCH section with zero readiness; it cannot promote to attack/
    // building because canonicalStage is forced to "watch" and the matcher
    // short-circuits these rows to called_miss (presence-only) on any
    // future HR. Eligibility floors are intentionally cheap so we cover the
    // long tail of "real" power threats without admitting all replacement
    // batters.
    let presenceSurfaced = 0;
    if (impactedMarkets.has("home_runs")) {
      for (const batter of state.battingOrder) {
        if (!batter.playerId || batter.playerId === "unknown") continue;
        if (!batter.slot || batter.slot < 1 || batter.slot > 9) continue;
        if (playersWithRealHrRow.has(batter.playerId)) continue;

        const rollingStats = mlbPlayerCache.batterRollingStats[batter.playerId];
        const playerContact = contactCache?.byPlayerId?.[batter.playerId];
        const oh = getOnlyHomersEnrichment(batter.playerName);

        const seasonHRRate = rollingStats?.seasonHRRate ?? null;
        const hrRateLast30 = rollingStats?.hrRateLast30 ?? null;
        const barrelRate = playerContact?.barrelPct != null
          ? playerContact.barrelPct / 100
          : null;

        const eligibilityReasons: string[] = [];
        if (seasonHRRate != null && seasonHRRate >= PRESENCE_FLOOR_SEASON_HR_RATE) eligibilityReasons.push(`seasonHRRate=${seasonHRRate.toFixed(3)}`);
        if (hrRateLast30 != null && hrRateLast30 >= PRESENCE_FLOOR_HR_RATE_L30) eligibilityReasons.push(`hrRateLast30=${hrRateLast30.toFixed(3)}`);
        if (barrelRate != null && barrelRate >= PRESENCE_FLOOR_BARREL_RATE) eligibilityReasons.push(`barrelRate=${barrelRate.toFixed(3)}`);
        if (oh.isHotHitter) eligibilityReasons.push(`hotHitter=${oh.hotHitterPeriod}/${oh.hotHitterHrCount}`);

        if (eligibilityReasons.length === 0) continue;

        const resolvedOpponent = state.homeTeamAbbr && state.awayTeamAbbr
          ? (batter.team === state.homeTeamAbbr ? state.awayTeamAbbr : state.homeTeamAbbr)
          : "";

        storage.createOrUpdateHrRadarAlert({
          gameId,
          playerId: batter.playerId,
          playerName: batter.playerName,
          team: batter.team,
          opponent: resolvedOpponent,
          inning: state.inning,
          half: state.isTopInning ? "top" : "bottom",
          readinessScore: 0,
          dynamicReadinessScore: null,
          canonicalStage: "watch",
          confidenceTier: "monitor",
          signalState: "watching",
          triggerTags: ["presence_floor", ...eligibilityReasons],
          summaryText: "On HR radar — power profile present",
          contactSnapshot: null,
          alertPath: null,
          alertTier: null,
          diagnosticsSnapshot: {
            presenceFloor: {
              reasons: eligibilityReasons,
              seasonHRRate,
              hrRateLast30,
              barrelRate,
              isHotHitter: oh.isHotHitter,
              hotHitterPeriod: oh.hotHitterPeriod,
              hotHitterHrCount: oh.hotHitterHrCount,
            },
          },
          buildScore: null,
          conversionProbabilityRaw: null,
          conversionProbability: null,
          peakConversionProbability: null,
          firstDetectedInning: null,
          firstDetectedHalf: null,
          firstDetectedAtMs: null,
          plateAppearancesTracked: 0,
          hasLiveABContext: false,
          isPresenceOnly: true,
        }).catch(err => console.warn(`[HR_PRESENCE_FLOOR] persist failed for ${batter.playerName}: ${err.message}`));
        presenceSurfaced++;
      }
    }
    console.log(`[HR_PRESENCE_FLOOR][${gameId}] surfaced=${presenceSurfaced} pathAE=${playersWithRealHrRow.size}`);

    // ── Pitcher markets: evaluate active pitcher only (skip unknown) ────────────
    const activePitcher = state.pitcherInGame;

    const pitcherToEval = activePitcher && activePitcher.playerId && activePitcher.playerId !== "unknown"
      ? activePitcher
      : null;

    if (!pitcherToEval) {
      console.warn(`[MLB orchestrator] Skipping pitcher markets — no identified active pitcher for game ${gameId}`);
    }

    if (pitcherToEval) {
      const pitcherCtx = pitcherCtxCache?.byPitcherId?.[pitcherToEval.playerId];

      for (const market of PITCHER_MARKETS) {
        if (!impactedMarkets.has(market)) continue;
        const currentPitchCount = pitcherCtx?.pitchCount ?? state.pitchCount ?? 0;
        const isPitcherEarlySignal = currentPitchCount < 10;
        const { remainingBF, remainingIP } = estimatePitcherRemainingBF(
          state.inning,
          currentPitchCount
        );
        const remainingPA = remainingBF;
        const remainingAB = remainingBF;

        console.log(`[MLB MARKET INPUT][${gameId}][${market}] { playerName: "${pitcherToEval.playerName}", playerId: "${pitcherToEval.playerId}", inning: ${state.inning} }`);

        const resolvedPitcherLine = await resolveBookLine(oddsEventId, pitcherToEval.playerName, market);
        auditRecordRaw(gameId);
        if (resolvedPitcherLine === null) {
          console.log(`[MLB MARKET SKIP][${gameId}][${market}] { playerName: "${pitcherToEval.playerName}", reason: "no_book_line" }`);
          auditRecordRejection(gameId, "staleOdds", market, "no_book_line_pitcher");
          continue;
        }
        if (resolvedPitcherLine.isDegraded) anyDegraded = true;

        const resolvedPitcherMarketObj = { line: resolvedPitcherLine.line, odds: (resolvedPitcherLine.overOdds !== null || resolvedPitcherLine.underOdds !== null) ? { overOdds: resolvedPitcherLine.overOdds, underOdds: resolvedPitcherLine.underOdds } : null };
        if (!hasRealOdds(resolvedPitcherMarketObj)) {
          console.warn(`[MLB orchestrator] hasRealOdds failed for pitcher ${pitcherToEval.playerName}/${market} — signalLocked=false, skipping computation`);
          console.log(`[MLB MARKET SKIP][${gameId}][${market}] { playerName: "${pitcherToEval.playerName}", reason: "no_real_odds", line: ${resolvedPitcherLine.line} }`);
          auditRecordRejection(gameId, "staleOdds", market, "no_real_odds_pitcher");
          continue;
        }
        auditRecordNormalized(gameId, market);

        const pitcherSeasonForPitcherMarket = mlbPlayerCache.pitcherSeasonStats[pitcherToEval.playerId];

        const pitcherKper9 = pitcherSeasonForPitcherMarket?.kPer9;
        const pitcherSeasonAvg = market === "pitcher_strikeouts"
          ? (pitcherKper9 != null ? pitcherKper9 : 6.0)
          : market === "pitcher_outs"
            ? 0.65
          : market === "hits_allowed"
            ? (pitcherSeasonForPitcherMarket?.whip != null ? pitcherSeasonForPitcherMarket.whip * 0.72 * 6 : 5.0)
            : 5.0;

        const pitcherOpponent = state.homeTeamAbbr && state.awayTeamAbbr
          ? (pitcherToEval.team === state.homeTeamAbbr ? state.awayTeamAbbr : state.homeTeamAbbr)
          : "";

        const input: MLBPropInput = {
          playerId: pitcherToEval.playerId,
          playerName: pitcherToEval.playerName,
          team: pitcherToEval.team,
          opponent: pitcherOpponent,
          gameId,
          market,
          bookLine: resolvedPitcherLine.line,
          overOdds: resolvedPitcherLine.overOdds,
          underOdds: resolvedPitcherLine.underOdds,
          seasonAvg: pitcherSeasonAvg,
          plateAppearances: pitcherCtx?.pitchCount
            ? Math.floor(pitcherCtx.pitchCount / 4)
            : 0,
          atBats: pitcherCtx?.pitchCount
            ? Math.floor(pitcherCtx.pitchCount / 4)
            : 0,
          currentStatValue: 0,
          remainingPA,
          remainingAB,
          completedAB: Math.max(0, 4 - remainingAB),
          inning: state.inning,
          isTopInning: state.isTopInning,
          batterHand: null,
          contactQuality: {
            exitVelocity: null,
            launchAngle: null,
            hitDistance: null,
            hardHitRateSeason: null,
            barrelRateProxySeason: null,
            avgBatSpeed: null,
            avgSwingLength: null,
            priorABResults: [],
            xBA: null,
            xSLG: null,
          },
          pitcher: {
            pitchCount: state.pitchCount,
            timesThrough: pitcherCtx?.timesThroughOrder ?? 1,
            era: pitcherSeasonForPitcherMarket?.era ?? null,
            whip: pitcherSeasonForPitcherMarket?.whip ?? null,
            kPer9: pitcherSeasonForPitcherMarket?.kPer9 ?? null,
            bbPer9: pitcherSeasonForPitcherMarket?.bbPer9 ?? null,
            managerLeashShort: pitcherCtx
              ? pitcherCtx.timesThroughOrder >= 3 && pitcherCtx.pitchCount > 80
              : false,
            isPitcherCollapsing: pitcherCtx
              ? (pitcherCtx.velocityDrop !== null && pitcherCtx.velocityDrop > 2)
              : false,
            pitchMix: pitcherCtx?.pitchMix ?? [],
            throws: pitcherToEval.throws ?? null,
            seasonAvgVelocity: pitcherCtx?.seasonAvgVelocity ?? null,
          },
          lineup: {
            battingOrderSlot: 5,
            orderTurnoverProximity: 0.5,
            lineupSectionStrength: "neutral",
            hittersAheadOnBase: 0,
            pocketWeakness: null,
          },
          weatherPark: {
            parkFactor: getMarketParkFactor(weatherCache?.venueName, market),
            temperature: resolvedTemp,
            windSpeed: resolvedWindSpeed,
            windDirection: resolvedWindDir,
            humidity: resolvedHumidity,
            isIndoors: weatherCache?.isIndoors ?? isVenueIndoors(weatherCache?.venueName),
            parkHistoryFactor: null,
            windShiftDetected: resolvedWindShift,
          },
          bullpen: {
            bullpenEra: bullpenCache?.bullpenEra ?? null,
            bullpenUsageLastThreeDays: bullpenCache?.bullpenUsageLastThreeDays ?? null,
            isTopRelieverAvailable: bullpenCache?.isTopRelieverAvailable ?? true,
          },
        };

        input.liveInterpretation = buildLiveEventInterpretation(input);

        pLog(gameId, "engineInput:pitcher", { player: input.playerName, market: input.market, bookLine: input.bookLine, parkFactor: input.weatherPark.parkFactor });

        const pitcherQualityLayers = {
          parkFactor: weatherCache?.venueName != null,
          weather: weatherCache?.temperature != null,
          pitcherERA: input.pitcher.era != null,
          pitcherWHIP: input.pitcher.whip != null,
          pitcherK9: input.pitcher.kPer9 != null,
          bullpen: bullpenCache?.bullpenEra != null,
        };
        const pitcherRealCount = Object.values(pitcherQualityLayers).filter(Boolean).length;
        const pitcherIsDegraded = pitcherRealCount <= 3;
        if (pitcherIsDegraded) {
          console.warn(`[MLB_INPUT_QUALITY] DEGRADED:pitcher game=${gameId} player=${input.playerName} market=${market} real=${pitcherRealCount}/6 layers=${JSON.stringify(pitcherQualityLayers)}`);
        }
        (input as any).isDegraded = pitcherIsDegraded;

        const guardError = validateMLBInput(input);
        if (guardError) {
          console.warn(`[MLB orchestrator] Skipping pitcher ${pitcherToEval.playerName}/${market}: ${guardError}`);
          console.log(`[MLB MARKET SKIP][${gameId}][${market}] { playerName: "${pitcherToEval.playerName}", reason: "guard_error:${guardError}" }`);
          continue;
        }

        try {
          const rawOutput = calculateMLBPropEdge(input);

          const fwResult = runIntegrityFirewall(rawOutput);
          logFirewallResult(gameId, rawOutput.playerName, market, fwResult);

          if (fwResult.hardReject) {
            signalsRejected++;
            console.log(`[MLB MARKET SKIP][${gameId}][${market}] { playerName: "${pitcherToEval.playerName}", reason: "firewall_hard_reject" }`);
            auditRecordRejection(gameId, "marketValidation", market, "firewall_hard_reject_pitcher");
            continue;
          }

          const output = fwResult.cappedOutput;

          const pArchForMarket = pitcherArch ?? "mid_rotation";
          // Trace: engine → firewall → final (no double-cap; engine is authoritative)
          console.log(`[MLB_PROB_TRACE] pitcher=${pitcherToEval.playerName} market=${market} arch=${pArchForMarket} engine=${rawOutput.calibratedProbability.toFixed(1)} postFw=${output.calibratedProbability.toFixed(1)} side=${output.recommendedSide} edge=${output.edge.toFixed(2)}`);

          if (output.recommendedSide === "OVER" || output.recommendedSide === "UNDER") {
            trackSignalDirection(market, output.recommendedSide);
          }

          pLog(gameId, "engineOutput:pitcher", { player: output.playerName, market: output.market, edge: output.edge, tier: output.confidenceTier, archetype: pArchForMarket });
          recordMLBDiagnostic(output);

          console.log(`[MLB engine] playerId=${pitcherToEval.playerId} player="${pitcherToEval.playerName}" market=${market} inning=${state.inning} remainingPA=${remainingPA} calibratedProbOver=${output.calibratedProbabilityOver.toFixed(2)} calibratedProbUnder=${output.calibratedProbabilityUnder.toFixed(2)} edge=${output.edge.toFixed(2)} side=${output.recommendedSide} arch=${pArchForMarket}`);

          outputs.push({ ...output });
          marketsEvaluated++;

          const qResult = this.qualifySignal(gameId, input, output);
          if (qResult && !isPitcherEarlySignal) {
            qResult.pitcherArchetype = pArchForMarket;
            qResult.safetyCeilingApplied = output.safetyCeilingApplied ?? false;
            qResult.varianceTier = MARKET_VOLATILITY[market] ?? "mid";
            qResult.isDegraded = !!(input as any).isDegraded;
            qResult.dataQuality = !!(input as any).isDegraded ? "degraded" : "partial";
            qualifiedSignals.push(qResult);
            allSignals.push(qResult);
            signalsQualified++;
            scoreSum += qResult.signalScore;
            auditRecordQualified(gameId, {
              market: qResult.market,
              probability: qResult.engineProbability ?? 0,
              signalScore: qResult.signalScore ?? 0,
              edge: (qResult as any).edge ?? 0,
              isHrWatch: false,
            });
          } else {
            if (!isPitcherEarlySignal) signalsRejected++;
            const watchSig = isPitcherEarlySignal
              ? (qResult ?? this.buildWatchSignal(gameId, input, output))
              : this.buildWatchSignal(gameId, input, output);
            if (watchSig) {
              auditRecordWatchSurfaced(gameId, market);
              watchSig.pitcherArchetype = pArchForMarket;
              watchSig.isDegraded = !!(input as any).isDegraded;
              if (isPitcherEarlySignal) {
                watchSig.confidenceTier = "WATCHLIST" as any;
                watchSig.isEarlySignal = true;
                watchSig.watchlist = true;
                watchSig.actionable = false;
                console.log(`[MLB EARLY_SIGNAL] pitcher ${pitcherToEval.playerName}/${market} game=${gameId} — early pitcher watchlist signal (pitchCount=${currentPitchCount}, edge=${output.edge.toFixed(1)})`);
              }
              allSignals.push(watchSig);
            }
          }
        } catch (err: any) {
          console.warn(`[MLB orchestrator] engine error for pitcher ${pitcherToEval.playerName} / ${market}:`, err.message);
          console.log(`[MLB MARKET SKIP][${gameId}][${market}] { playerName: "${pitcherToEval.playerName}", reason: "engine_error:${(err as any).message}" }`);
        }
      }
    }

    const now = Date.now();
    const signalLocked = allSignals.length > 0;

    const gameCardTags = deriveGameCardTags(
      qualifiedSignals.map((s) => ({
        signalTags: s.signalTags as any,
        market: s.market,
        recommendedSide: s.side,
        signalScore: s.signalScore,
      }))
    );
    for (const sig of qualifiedSignals) {
      sig.gameCardSignalTags = gameCardTags as string[];
    }

    const familyEnriched = applyFamilySuppression(allSignals);
    let flagshipCount = 0;
    for (const enriched of familyEnriched) {
      const sig = allSignals.find(s => s.id === enriched.id);
      if (sig) {
        sig.familyId = enriched.familyResult.familyId;
        sig.familyRank = enriched.familyResult.siblingRank;
        sig.isFlagship = enriched.familyResult.isFlagship;
        sig.familyPenaltyFactor = enriched.familyResult.familyPenaltyFactor;
        if (enriched.familyResult.isFlagship) flagshipCount++;
        if (!enriched.familyResult.isFlagship && enriched.familyResult.familyPenaltyFactor < 1) {
          sig.signalScore = Math.round(sig.signalScore * enriched.familyResult.familyPenaltyFactor);
          const isSigBatterOver = sig.side === "OVER" && !["pitcher_strikeouts", "pitcher_outs", "hits_allowed"].includes(sig.market);
          const familyWatchThreshold = isSigBatterOver ? 42 : 55;
          if (sig.signalScore < familyWatchThreshold) {
            sig.confidenceTier = "WATCHLIST";
            sig.watchlist = true;
          }
        }
      }
    }
    console.log(`[MLB_FAMILY_SUPPRESSION][${gameId}] signals=${allSignals.length} flagships=${flagshipCount}`);

    allSignals.sort((a, b) => {
      const aDeg = a.isDegraded ? 1 : 0;
      const bDeg = b.isDegraded ? 1 : 0;
      if (aDeg !== bDeg) return aDeg - bDeg;
      const aFlagship = a.isFlagship ? 0 : 1;
      const bFlagship = b.isFlagship ? 0 : 1;
      if (aFlagship !== bFlagship) return aFlagship - bFlagship;
      return (b.signalScore ?? 0) - (a.signalScore ?? 0);
    });

    const existingCache = mlbEdgeCache.get(gameId);
    // Preserve when this cycle produced no signals at all (transient blank
    // between innings, all watch signals returned null, etc.) so the user's
    // feed doesn't briefly empty itself mid-game. The previous version only
    // preserved when marketsEvaluated === 0, but a cycle can evaluate dozens
    // of markets and still emit zero signals (every watch fails the side/odds
    // gate); that empty cycle would wipe a populated cache.
    const isThisCycleEmpty = allSignals.length === 0;
    // Bumped 10m -> 20m so signals persist through longer natural game gaps
    // (mid-inning pitching changes, replay reviews, weather delays, between
    // PA dugout time). The /api/mlb/edge-feed freshness filter honors
    // preservedAt, so this window is the upper bound on how long a signal
    // stays visible on a fully-blank engine cycle.
    const PRESERVE_MAX_AGE_MS = 20 * 60 * 1000;
    const cacheAge = now - Math.max(existingCache?.updatedAt ?? 0, existingCache?.createdAt ?? 0);
    if (isThisCycleEmpty && existingCache && existingCache.allSignals.length > 0 && cacheAge < PRESERVE_MAX_AGE_MS) {
      // Freshness Integrity Fix #2.2 — preserve the prior signals on a blank
      // cycle, but DO NOT touch updatedAt: faking the timestamp here is what
      // made the heartbeat-recompute (45s threshold) appear unnecessary and
      // hid genuine staleness from the UI. Mark the entry as degraded and
      // record when the preservation happened, so downstream code can see it.
      mlbEdgeCache.set(gameId, {
        ...existingCache,
        isDegraded: true,
        preservedAt: now,
      } as any);
      console.log(`[MLB QUALIFICATION][${gameId}] marketsEvaluated=${marketsEvaluated} qualified=0 rejected=${signalsRejected} PRESERVED ${existingCache.allSignals.length} existing signals (this cycle blank, last good cycle within ${Math.round(cacheAge/1000)}s) — updatedAt unchanged, isDegraded=true`);
      auditEndCycle(gameId);

      // Phase 1 Gold Master — drift snapshot for the PRESERVED-cache branch.
      // Without this, sustained empty cycles would silently stop emitting
      // [MLB_SIGNAL_PARITY] / [MLB_DRIFT_WARNING] for this game (architect
      // review finding). Passive observation only.
      try {
        recordDriftSnapshot({
          gameId,
          marketsEvaluated,
          qualifiedSignals: 0,
          rejectedSignals: signalsRejected,
          signals: [],
          payloadFieldSample: undefined,
        });
      } catch (err) {
        console.warn("[MLB_DRIFT_WARNING] snapshot_failed:", (err as Error).message);
      }
    } else {
      mlbEdgeCache.set(gameId, {
        gameId,
        outputs,
        qualifiedSignals,
        allSignals,
        gameCardTags: gameCardTags as string[],
        updatedAt: now,
        createdAt: existingCache?.createdAt ?? now,
        isDegraded: anyDegraded,
        signalLocked,
      });
      const avgScore = signalsQualified > 0 ? Math.round(scoreSum / signalsQualified) : 0;
      console.log(`[MLB QUALIFICATION][${gameId}] marketsEvaluated=${marketsEvaluated} qualified=${signalsQualified} rejected=${signalsRejected} allSignals=${allSignals.length} avgScore=${avgScore} gameCardTags=[${gameCardTags.join(",")}]`);
      auditEndCycle(gameId);

      // Phase 1 Gold Master — record drift snapshot for this cycle.
      // Passive observation only; never mutates engine math or surfacing.
      try {
        const sampleSig = allSignals[0] as Record<string, any> | undefined;
        recordDriftSnapshot({
          gameId,
          marketsEvaluated,
          qualifiedSignals: signalsQualified,
          rejectedSignals: signalsRejected,
          signals: allSignals as any,
          payloadFieldSample: sampleSig ? Object.keys(sampleSig) : undefined,
        });
      } catch (err) {
        // Drift recording must NEVER break the qualification cycle.
        console.warn("[MLB_DRIFT_WARNING] snapshot_failed:", (err as Error).message);
      }

      // [MLB_PRE_CHANGE_AUDIT] STEP 3 — Surfaced signals trace at orchestrator
      // (what is actually written to mlbEdgeCache and read by display routes).
      // Engine-layer [MLB_SURFACED_SIGNALS] reflects per-engine-call output;
      // this one reflects the post-qualification UI-facing reality.
      console.log(`[MLB_SURFACED_SIGNALS] ${JSON.stringify({
        layer: "orchestrator",
        gameId,
        qualifiedCount: qualifiedSignals.length,
        allSignalsCount: allSignals.length,
        marketsEvaluated,
        rejected: signalsRejected,
        players: qualifiedSignals.slice(0, 10).map(s => s.playerName),
        markets: qualifiedSignals.slice(0, 10).map(s => s.market),
        gameCardTags,
        isDegraded: anyDegraded,
      })}`);

      // [MLB_PRE_CHANGE_AUDIT] STEP 4 — Empty-state warning at orchestrator.
      // Distinct from engine-layer [MLB_EMPTY_STATE]: this fires when the
      // engine produced output but qualification gates rejected everything,
      // OR when the engine itself produced nothing for this game cycle.
      if (qualifiedSignals.length === 0) {
        console.warn(`[MLB_EMPTY_STATE] ${JSON.stringify({
          layer: "orchestrator",
          gameId,
          marketsEvaluated,
          rejected: signalsRejected,
          allSignalsCount: allSignals.length,
          outputsCount: outputs.length,
          message: outputs.length > 0
            ? "QUALIFICATION_REJECTED_ALL"
            : (marketsEvaluated > 0 ? "ENGINE_PRODUCED_NOTHING" : "NO_MARKETS_EVALUATED"),
        })}`);
      }

      autoPersistMLBSignals(gameId, qualifiedSignals);

      // ── LiveLocks Batch D — Orchestrator-driven bus population ────────
      // Per Batch D constraint: the bus MUST be populated from the
      // orchestrator after qualification, NOT from authed route reads
      // (/api/mlb/edge-feed previously was the only path). Without this
      // hook the bus stayed empty until the first authed user hit the
      // edge-feed, and observability tags ([HR_RADAR_TRANSITION],
      // alerts, hr-radar/ladder canonical reads) all stayed silent.
      //
      // We mirror the exact normalize call shape the edge-feed handler
      // uses so the canonical signal id / contract / mirror behavior is
      // bit-for-bit identical. normalizeMLBSignal internally calls
      // registerSignal → recordCanonical → notifyLifecycleChange. Pure
      // additive: orchestrator behavior unchanged, mlbEdgeCache write
      // already happened above, this loop only feeds the bus.
      try {
        const { normalizeMLBSignal } = await import("./normalizeSignal");
        const { normalizeMlbMarketKey } = await import("./normalizeMarketKey");
        const rawOutputLookup = new Map(
          (outputs ?? []).map((o: any) => [`${o.playerId}_${normalizeMlbMarketKey(o.market)}`, o])
        );
        const gameState = mlbGameCache.gameState[gameId] ?? null;
        let busRegistered = 0;
        for (const qs of qualifiedSignals) {
          try {
            const raw = rawOutputLookup.get(`${qs.playerId}_${normalizeMlbMarketKey(qs.market)}`);
            normalizeMLBSignal(qs as any, {
              gameId,
              rawOutput: raw ?? null,
              gameState: gameState as any,
              game: null,
              pitchMixFallback: null,
            });
            busRegistered++;
          } catch (perSigErr) {
            console.warn(`[LL_BUS_POPULATE] per-signal normalize failed player=${(qs as any).playerName} market=${qs.market} reason=${(perSigErr as Error).message}`);
          }
        }
        if (busRegistered > 0) {
          console.log(`[LL_BUS_POPULATE] gameId=${gameId} registered=${busRegistered} qualified=${qualifiedSignals.length}`);
        }
      } catch (busErr) {
        console.warn(`[LL_BUS_POPULATE] bus population failed gameId=${gameId} reason=${(busErr as Error).message}`);
      }
    }
    return outputs;
  }
}

// ── Auto-persist qualified MLB signals to persisted_plays ────────────────────

// Per-canonical-key persistence guard. Tracks the last persisted signalScore
// and the last persistence timestamp. Re-persist is allowed when EITHER:
//   (a) the new signalScore is strictly greater than the cached score
//       (positive momentum: e.g. tier escalated, EV bumped), OR
//   (b) the new signalScore differs by ≥ MOMENTUM_DELTA in either direction
//       (state transition: cooling, decay, soft veto change), OR
//   (c) more than REPERSIST_WINDOW_MS has elapsed since the last persistence
//       (time-windowed refresh so the served feed never freezes mid-game).
// This keeps /api/top-plays and downstream consumers (mobile/PWA dashboard,
// unified top plays panel) live and responsive instead of going stale after
// the first qualifying tick.
const mlbPersistGuard = new Map<string, { score: number; ts: number }>();
const REPERSIST_WINDOW_MS = 5 * 60 * 1000; // 5 min refresh window
const MOMENTUM_DELTA = 5; // signalScore points either direction

function autoPersistMLBSignals(gameId: string, qualifiedSignals: MLBQualifiedSignal[]): void {
  const today = todayET();
  const now = Date.now();
  let persisted = 0;
  let skipped = 0;
  let skipReasons: Record<string, number> = {};

  for (const sig of qualifiedSignals) {
    const isBatterOverWatch = sig.marketFamily === "batter_over" && sig.mode === "watch";
    if ((sig.watchlist && !isBatterOverWatch) || sig.isEarlySignal) { skipped++; skipReasons["watchlist"] = (skipReasons["watchlist"] ?? 0) + 1; continue; }
    const sbk = sig.sportsbook && sig.sportsbook.trim() !== "" ? sig.sportsbook : "odds_api";
    if (!Number.isFinite(sig.line) || sig.line <= 0) { skipped++; skipReasons["bad_line"] = (skipReasons["bad_line"] ?? 0) + 1; continue; }

    const dir = sig.side === "OVER" ? "over" : sig.side === "UNDER" ? "under" : null;
    if (!dir) { skipped++; skipReasons["no_dir"] = (skipReasons["no_dir"] ?? 0) + 1; continue; }

    const canonicalKey = `${sig.playerId}|${sig.market}|${dir}|${gameId}|${today}`;
    const prev = mlbPersistGuard.get(canonicalKey);
    const curScore = sig.signalScore ?? 0;
    if (prev !== undefined) {
      const ageMs = now - prev.ts;
      const scoreUp = curScore > prev.score;
      const movedSignificantly = Math.abs(curScore - prev.score) >= MOMENTUM_DELTA;
      const stale = ageMs >= REPERSIST_WINDOW_MS;
      if (!scoreUp && !movedSignificantly && !stale) {
        skipped++;
        skipReasons["dedup"] = (skipReasons["dedup"] ?? 0) + 1;
        continue;
      }
    }
    mlbPersistGuard.set(canonicalKey, { score: curScore, ts: now });

    trackPlay({
      gameId,
      playerId: sig.playerId,
      playerName: sig.playerName,
      team: sig.team ?? null,
      sport: "mlb",
      market: sig.market,
      direction: dir,
      line: sig.line,
      projection: sig.projection,
      probability: sig.engineProbability,
      edge: sig.evPct ?? 0,
      sportsbook: sbk,
      derivedLine: false,
      createdAt: sig.engineGeneratedAt ?? Date.now(),
      signalScore: sig.signalScore ?? null,
      confidenceTier: sig.confidenceTier ?? null,
      inning: sig.inning ?? null,
      abNumber: sig.completedAB ?? null,
      opportunityScore: sig.opportunityScore ?? null,
      liveScore: sig.liveScore ?? null,
      eventBoost: sig.eventBoost ?? null,
      signalMode: sig.mode ?? null,
      marketFamily: sig.marketFamily ?? null,
    }, storage).catch(err => console.warn(`[MLB_AUTO_PERSIST] failed: ${err.message}`));
    persisted++;
  }

  const reasonStr = Object.entries(skipReasons).map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(`[MLB_AUTO_PERSIST] game=${gameId} qualified=${qualifiedSignals.length} persisted=${persisted} skipped=${skipped} ${reasonStr}`);
}

function resetDailyPersistGuard(): void {
  const today = todayET();
  for (const key of Array.from(mlbPersistGuard.keys())) {
    if (!key.endsWith(today)) mlbPersistGuard.delete(key);
  }
}

// ── Singleton export ──────────────────────────────────────────────────────────

export const liveOrchestrator = new LiveGameOrchestrator();
