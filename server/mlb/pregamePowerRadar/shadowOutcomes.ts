// Pre-Game Power Radar — shadow outcomes + live bridge (Phase 4/5).
//
// Grades pre-game targets in their OWN track only:
//   • Live bridge (read-only): cross-references the live HR canonical store to
//     mark whether a target later became live Ready / Fire. Never mutates the
//     live engine — pure reads via getCanonicalHrRadarState.
//   • Shadow outcomes: grades a target as soon as the box score confirms a HR
//     (live or final — mlbGameCache's box score is refreshed every 6-15s for
//     an actively-polled live game, so a win doesn't sit waiting for the whole
//     game to end). A miss (calibration_miss) still requires the game to be
//     final, since "no HR" can't be declared while the batter has plate
//     appearances left.
//
// Writes ONLY to the pre-game store + pregame tables. Never persisted_plays /
// ROI / official W-L. Labels stay "pregame target hit rate" — a proxy, not
// official record.

import { storage } from "../../storage";
import { getCanonicalHrRadarState } from "../hrRadarCanonicalStore";
import { mlbGameCache } from "../dataPullService";
import { getSnapshot, commitGradedSignal } from "./pregamePowerRadarStore";
import { deriveWinAttribution } from "./winAttribution";
import type { PregameOutcome, PregamePowerSignal } from "./types";
import type { PregameCalibrationRecord } from "../../../shared/pregameRadarWin";

/** Canonical live-HR hit inning lookup, keyed by `${gameId}|${playerId}`. */
type CanonicalHitLookup = Map<string, { hitInning: number | null; hitHalf: string | null }>;

/** Read-only: did this batter reach live Ready/Fire in the live HR radar? */
function liveBridge(signal: PregamePowerSignal): {
  becameLiveReady: boolean;
  becameLiveFire: boolean;
  convertedLiveAt: string | null;
} {
  const state = getCanonicalHrRadarState(signal.gameId, signal.batterId);
  if (!state) {
    return {
      becameLiveReady: signal.becameLiveReady,
      becameLiveFire: signal.becameLiveFire,
      convertedLiveAt: signal.convertedLiveAt,
    };
  }
  const ls = state.lifecycleState;
  const ready = ls === "ready" || ls === "fire" || ls === "cashed";
  const fire = ls === "fire" || ls === "cashed";
  const convertedLiveAt = signal.convertedLiveAt ?? (ready ? state.updatedAt : null);
  return { becameLiveReady: signal.becameLiveReady || ready, becameLiveFire: signal.becameLiveFire || fire, convertedLiveAt };
}

/**
 * Resolve final-game box-score outcome for a target, when available, and stamp
 * the win-attribution result (pregame_win vs calibration_miss) plus HR inning /
 * plate-appearance detail. `canonicalHit` is an optional inning fallback drawn
 * from the live HR Radar canonical store.
 */
function resolveOutcome(
  signal: PregamePowerSignal,
  canonicalHit?: { hitInning: number | null; hitHalf: string | null } | null,
): PregameOutcome | null {
  const box = mlbGameCache.gameBoxScore[signal.gameId];
  const line = box?.byPlayerId?.[signal.batterId];
  if (!line) return null;

  const hitHr = (line.hr ?? 0) > 0;

  // Inning + plate-appearance detail: prefer the player's own ordered ABs from
  // the play feed; fall back to the play-feed HR list, then the canonical hit.
  const priorABResults =
    mlbGameCache.contactData[signal.gameId]?.byPlayerId?.[signal.batterId]?.priorABResults ?? null;
  const hrPlay = mlbGameCache.hrPlays[signal.gameId]?.plays?.find(
    (p) => String(p.playerId) === String(signal.batterId),
  );

  const attribution = deriveWinAttribution({
    hitHr,
    wasPubliclyFlagged: signal.everPubliclyFlagged,
    priorABResults,
    hrPlayInning: hrPlay?.inning ?? null,
    hrPlayHalf: hrPlay?.halfInning ?? null,
    canonicalHitInning: canonicalHit?.hitInning ?? null,
    canonicalHitHalf: canonicalHit?.hitHalf ?? null,
  });

  return {
    hitHr,
    totalBases: line.tb ?? null,
    hitRecorded: (line.hits ?? 0) > 0,
    rbiRecorded: line.rbi ?? null,
    resolvedAt: new Date().toISOString(),
    outcome: attribution.outcome,
    userVisible: attribution.userVisible,
    hrInning: attribution.hrInning,
    hrHalf: attribution.hrHalf,
    plateAppearanceNumber: attribution.plateAppearanceNumber,
    firstAbPregameWin: attribution.firstAbPregameWin,
  };
}

/**
 * Persist a graded signal, retrying a bounded number of times on failure
 * before giving up. Returns true only on a confirmed successful write. The
 * DB upsert is already idempotent (terminal-once-graded `status`, COALESCE'd
 * `outcomes` — see storage.upsertPregamePowerRadarSignal), so re-attempting
 * the identical write is always safe.
 */
export async function persistSignalWithRetry(signal: PregamePowerSignal, attempts = 2): Promise<boolean> {
  const retryDelaysMs = [250, 750];
  for (let attempt = 0; attempt <= attempts; attempt++) {
    try {
      await storage.upsertPregamePowerRadarSignal({
        signalId: signal.signalId,
        buildId: signal.buildId,
        sessionDate: signal.sessionDate,
        gameId: signal.gameId,
        gameDate: signal.gameDate,
        startsAt: signal.startsAt ?? null,
        gameStatus: signal.gameStatus,
        firstPitchLockEligible: signal.firstPitchLockEligible,
        batterId: signal.batterId,
        batterName: signal.batterName,
        team: signal.team,
        opponent: signal.opponent,
        pitcherId: signal.pitcherId ?? null,
        pitcherName: signal.pitcherName ?? null,
        battingOrderSlot: signal.battingOrderSlot ?? null,
        primaryMarket: signal.primaryMarket,
        marketTags: signal.marketTags,
        marketScores: signal.marketScores,
        score10: String(signal.score10),
        tier: signal.tier,
        drivers: signal.drivers,
        warnings: signal.warnings,
        diagnostics: signal.diagnostics,
        lineupStatus: signal.lineupStatus,
        weatherStatus: signal.weatherStatus,
        hasMarketLine: signal.hasMarketLine,
        isOfficialPlay: false,
        isPregameTarget: true,
        status: signal.status,
        suppressed: signal.suppressed,
        suppressedReasons: signal.suppressedReasons,
        outcomes: signal.outcomes ?? null,
        everPubliclyFlagged: signal.everPubliclyFlagged,
        becameLiveReady: signal.becameLiveReady,
        becameLiveFire: signal.becameLiveFire,
        convertedLiveAt: signal.convertedLiveAt ? new Date(signal.convertedLiveAt) : null,
        lockedAt: signal.lockedAt ? new Date(signal.lockedAt) : null,
        gradedAt: signal.status === "graded" ? new Date() : null,
      });
      return true;
    } catch (err: any) {
      if (attempt < attempts) {
        console.warn(`[PREGAME_RADAR_PERSIST_RETRY] ${signal.signalId} attempt=${attempt + 1} message=${err?.message}`);
        await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt] ?? 750));
        continue;
      }
      console.error(`[PREGAME_RADAR_PERSIST_FAILED] ${signal.signalId}`, {
        sessionDate: signal.sessionDate,
        gameId: signal.gameId,
        batterId: signal.batterId,
        message: err?.message,
        stack: err?.stack,
      });
      return false;
    }
  }
  return false;
}

/**
 * Single grading pass over the current snapshot. Updates in-memory signals and
 * persists them. Never throws into runtime.
 *
 * Copy-on-write: each signal's grading mutations are applied to a fresh
 * `draft` object, never to the live `original` reference held in the
 * snapshot's Map. The DB write only happens against `draft`, and only on
 * confirmed persist success is `draft` committed back into the store (via a
 * compare-and-swap keyed on the exact `original` reference) — so in-memory
 * "graded" state and durable DB state can never diverge for longer than one
 * failed write, and a failed write leaves the original signal completely
 * untouched, naturally retriable on the next tick with no rollback logic
 * needed.
 */
export async function gradePregameOutcomes(): Promise<{ bridged: number; graded: number }> {
  const snapshot = getSnapshot();
  if (!snapshot) return { bridged: 0, graded: 0 };

  let bridged = 0;
  let graded = 0;

  // One read-only fetch of the live HR Radar canonical hits for inning fallback.
  // Best-effort: a failure just leaves attribution to the play-feed sources.
  let canonicalHits: CanonicalHitLookup = new Map();
  try {
    const canonical = await storage.getCanonicalHrRadarOutcomes(snapshot.sessionDate);
    canonicalHits = new Map(
      canonical.hits.map((h) => [
        `${h.gameId}|${h.playerId}`,
        { hitInning: h.hitInning ?? null, hitHalf: h.hitHalf ?? null },
      ]),
    );
  } catch {
    // leave canonicalHits empty
  }

  for (const original of Array.from(snapshot.signals.values())) {
    let changed = false;
    const draft: PregamePowerSignal = { ...original };

    // ── Live bridge (read-only) ───────────────────────────────────────────────
    const bridge = liveBridge(draft);
    if (
      bridge.becameLiveReady !== draft.becameLiveReady ||
      bridge.becameLiveFire !== draft.becameLiveFire ||
      bridge.convertedLiveAt !== draft.convertedLiveAt
    ) {
      draft.becameLiveReady = bridge.becameLiveReady;
      draft.becameLiveFire = bridge.becameLiveFire;
      draft.convertedLiveAt = bridge.convertedLiveAt;
      changed = true;
      bridged++;
      console.log(`[PREGAME_POWER_RADAR_BRIDGE] ${draft.signalId} ready=${bridge.becameLiveReady} fire=${bridge.becameLiveFire}`);
    }

    // ── Shadow outcome + win attribution ──────────────────────────────────────
    // A HR is graded the moment the box score confirms it — mlbGameCache's box
    // score is kept fresh every 6-15s for a live-tracked live game (far inside
    // this function's own 5-minute tick), so waiting for the whole game to
    // reach "final" only delayed a real win by however long the game had left
    // to play, sometimes hours. Only a *miss* (calibration_miss) genuinely
    // needs the game to be over — you can't call "no HR" while the batter
    // still has plate appearances left.
    if (draft.status !== "graded") {
      const outcome = resolveOutcome(draft, canonicalHits.get(`${draft.gameId}|${draft.batterId}`));
      if (outcome && (outcome.hitHr === true || draft.gameStatus === "final")) {
        draft.outcomes = outcome;
        draft.status = "graded";
        changed = true;
        graded++;
        console.log(`[PREGAME_POWER_RADAR_GRADED] ${draft.signalId} hr=${outcome.hitHr} tb=${outcome.totalBases} rbi=${outcome.rbiRecorded}`);
        // Win Attribution: hits are public wins; misses are calibration only.
        if (outcome.outcome === "pregame_win" && outcome.userVisible) {
          console.log(
            `[PREGAME_RADAR_WIN] ${draft.signalId} player=${draft.batterName} inning=${outcome.hrInning ?? "?"} pa=${outcome.plateAppearanceNumber ?? "?"} firstAb=${outcome.firstAbPregameWin === true}`,
          );
          // Logged once at grading time (not per HTTP read) so polling clients
          // never multiply this into per-request log spam — see
          // buildPregameRadarWinItem for the same slateDateET resolution.
          console.log("[PREGAME_RADAR_DATE_KEY]", {
            playerName: draft.batterName,
            gameId: draft.gameId,
            rawGameDate: draft.gameDate,
            gameStartTime: draft.startsAt,
            slateDateET: draft.sessionDate,
            settlementTime: outcome.resolvedAt,
            groupedUnder: draft.sessionDate,
          });
        } else if (outcome.outcome === "pregame_win") {
          console.log(`[PREGAME_RADAR_WIN_INTERNAL] ${draft.signalId} player=${draft.batterName} (homered, not publicly flagged)`);
        } else {
          console.log(`[PREGAME_CALIBRATION_MISS] ${draft.signalId} player=${draft.batterName} (no HR — internal calibration only)`);
        }
      }
    }

    if (changed) {
      const persisted = await persistSignalWithRetry(draft);
      if (persisted) {
        const committed = commitGradedSignal(original, draft);
        if (!committed) {
          console.warn(
            `[PREGAME_RADAR_COMMIT_SUPERSEDED] ${draft.signalId} — a newer snapshot/signal already replaced this one during persistence; next tick reconciles`,
          );
        }
      }
      // On persist failure, `draft` is discarded and `original` in the Map is
      // untouched — automatically retriable on the next 5-minute tick. No
      // rollback bookkeeping needed since nothing was ever mutated in place.
    }
  }

  return { bridged, graded };
}

/** Summary for admin diagnostics — pregame-only proxy metrics (never official ROI). */
export function getPregameOutcomeSummary(): {
  total: number;
  graded: number;
  hrHitRate: number | null;
  becameLiveReady: number;
  becameLiveFire: number;
  conversionRate: number | null;
  calibrationRecord: PregameCalibrationRecord;
} {
  const snapshot = getSnapshot();
  const all = snapshot ? Array.from(snapshot.signals.values()) : [];
  const public_ = all.filter((s) => !s.suppressed);
  const graded = public_.filter((s) => s.status === "graded" && s.outcomes);
  const hrHits = graded.filter((s) => s.outcomes?.hitHr).length;
  const becameLiveReady = public_.filter((s) => s.becameLiveReady).length;
  const becameLiveFire = public_.filter((s) => s.becameLiveFire).length;
  return {
    total: public_.length,
    graded: graded.length,
    hrHitRate: graded.length > 0 ? Math.round((hrHits / graded.length) * 1000) / 10 : null,
    becameLiveReady,
    becameLiveFire,
    conversionRate: public_.length > 0 ? Math.round((becameLiveReady / public_.length) * 1000) / 10 : null,
    calibrationRecord: getPregameCalibrationRecord(),
  };
}

/**
 * Pregame Radar Record + admin calibration rollup. Wins are public hits;
 * calibration misses are internal-only (never decrement a public record).
 */
export function getPregameCalibrationRecord(): PregameCalibrationRecord {
  const snapshot = getSnapshot();
  const all = snapshot ? Array.from(snapshot.signals.values()) : [];
  const graded = all.filter((s) => s.status === "graded" && s.outcomes);

  let wins = 0;
  let firstAbWins = 0;
  let calibrationMisses = 0;
  let internalWins = 0;

  for (const s of graded) {
    const o = s.outcomes!;
    if (o.outcome === "pregame_win") {
      if (o.userVisible === true) {
        wins++;
        if (o.firstAbPregameWin === true) firstAbWins++;
      } else {
        internalWins++;
      }
    } else if (o.outcome === "calibration_miss") {
      calibrationMisses++;
    }
  }

  // Public win rate denominator = publicly-flagged graded targets (wins +
  // public calibration misses). Internal (unflagged) hits are excluded.
  const publicGraded = graded.filter(
    (s) => s.everPubliclyFlagged && s.outcomes?.outcome != null,
  ).length;

  return {
    wins,
    firstAbWins,
    calibrationMisses,
    internalWins,
    totalGraded: graded.length,
    winRate: publicGraded > 0 ? Math.round((wins / publicGraded) * 1000) / 10 : null,
  };
}

