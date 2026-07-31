// Mound Radar V2 (shadow) — pure grading-decision logic (Flagship Program
// Phase 2, Part 5). No storage import — fully unit-testable without a
// database. The DB-touching sweep/regrade orchestration built on top of
// these functions lives in the sibling moundV2ShadowGradingSweep.ts, which
// requires DATABASE_URL (same split as V1's pure moundOutcomeAttribution.ts
// vs its storage-touching moundShadowOutcomes.ts).
//
// Design mirrors the proven V1 grading pipeline deliberately, not by
// coincidence:
//   - Passive box-score reads only. Neither this file nor its sweep sibling
//     ever calls syncGameBoxScore — grading reads whatever
//     mlbGameCache.gamePitchingBoxScore already holds, exactly like V1's own
//     gradeMoundOutcomes() does. That cache is kept warm by the Live Edge
//     orchestrator's own polling for any game it's tracking; if a game's box
//     score genuinely never syncs, the honest answer is "still pending"
//     forever, never a fabricated stat.
//   - "Outing complete" (this pitcher's own final Ks/outs are locked) uses
//     the same hasPitcherBeenPulled semantics V1's moundOutcomeAttribution.ts
//     uses, combined with whole-game finality from the MLB Stats API's own
//     status block (GamePitchingBoxScoreGameStatus, additive on
//     dataPullService.ts's cache, independent of V1's ESPN-derived
//     MoundGameStatus). Deliberately DUPLICATED below (hasPitcherBeenPulled),
//     not imported — moundOutcomeAttribution.ts is V1's own settlement module
//     and is explicitly on moundV2Engine.test.ts's production-module
//     blocklist (unlike the narrower pure component scorers moundV1Adapters.ts
//     reuses directly), so this file keeps zero import edges into it. The
//     four-line function is trivial to keep in sync by inspection.
//   - Grading always waits for true outingComplete for BOTH markets. Unlike
//     V1's "gradedLive" partial-credit shortcut (which exists purely to show
//     a win badge sooner for UX), this is a research/measurement pipeline —
//     there is no UX to accelerate, so waiting for the one true final number
//     every time is strictly better for calibration accuracy.
//   - "Never grade against a later line": frozenLine is a plain input
//     parameter here, never looked up — structurally guaranteed by this
//     function's signature, which has no market-lookup capability at all.
//
// Idempotency / audit discipline (referenced from storage.ts's
// gradeMoundV2ShadowPrediction doc comment): computeMoundV2GradingDecision
// is the single decision function every grading path (sweep + regrade)
// funnels through, and it is the source of the whole pipeline's
// idempotency guarantee — a "hold" verdict is a pure no-op (nothing is ever
// written for it), so calling it repeatedly with unchanged inputs is always
// safe, and a "grade"/"void" verdict is a one-way terminal transition the
// sweep never revisits (see moundV2ShadowGradingSweep.ts: the sweep only
// ever lists settlementStatus="pending" rows). Re-grading an
// already-terminal row is a separate, deliberately-invoked operation
// (regradeMoundV2ShadowPrediction in the sweep sibling), not something this
// decision function or the routine sweep ever do automatically.

import type { GamePitchingBoxScoreGameStatus, GamePitchingBoxScorePitcher } from "../../../dataPullService";

/**
 * Has this pitcher been pulled from the game? True when their ID appears in
 * the team's live appearance order but is NOT the last entry, meaning a
 * later pitcher has since taken the mound. Duplicated from V1's
 * moundOutcomeAttribution.ts (hasPitcherBeenPulled) rather than imported —
 * see the file header for why. A missing/empty order (box score not synced
 * yet, or this pitcher hasn't recorded a line at all) is treated as "not
 * pulled" — never fabricates certainty from absent data.
 */
function hasPitcherBeenPulled(pitcherId: string, appearanceOrder: string[] | null | undefined): boolean {
  if (!appearanceOrder || appearanceOrder.length === 0) return false;
  const idx = appearanceOrder.indexOf(String(pitcherId));
  if (idx === -1) return false;
  return idx < appearanceOrder.length - 1;
}

// ─────────────────────────────────────────────────────────────────────────
// Pure: official game-status classification
// ─────────────────────────────────────────────────────────────────────────

export type MoundV2GradingGameStatus =
  | "final"
  | "in_progress"
  | "not_yet_played"
  | "postponed_or_suspended"
  | "cancelled"
  | "unknown";

/**
 * Classifies the MLB Stats API's own status block for grading purposes.
 * Keyword checks on detailedState take priority over the coarse
 * abstractGameState bucket — MLB reports a suspended/postponed game under
 * different abstractGameState values depending on when it's queried
 * relative to resumption, but the detailedState text is the reliable tell.
 * Missing/absent status is honestly "unknown" (hold), never assumed final.
 */
export function classifyMoundV2GameStatusForGrading(
  status: GamePitchingBoxScoreGameStatus | null | undefined,
): MoundV2GradingGameStatus {
  if (!status) return "unknown";
  const detailed = (status.detailedState ?? "").toLowerCase();
  const abstractState = status.abstractGameState ?? "";

  if (detailed.includes("cancel")) return "cancelled";
  if (detailed.includes("suspend") || detailed.includes("postpon")) return "postponed_or_suspended";

  if (abstractState === "Final") return "final";
  if (abstractState === "Live") return "in_progress";
  if (abstractState === "Preview") {
    if (detailed.includes("delay")) return "postponed_or_suspended";
    return "not_yet_played";
  }
  return "unknown";
}

// ─────────────────────────────────────────────────────────────────────────
// Pure: line comparison
// ─────────────────────────────────────────────────────────────────────────

/**
 * Objective market outcome relative to the frozen line — side-agnostic by
 * design (V2 carries full OVER/UNDER/push probabilities, never a single
 * recommended side the way V1's Follow/Fade does, so "what actually
 * happened" and "was the model right" are deliberately kept separate; the
 * latter is Part 6's comparison-report concern, not this row's).
 * A null/non-finite line (e.g. today's pitcher_outs market, which has no
 * real sportsbook feed) honestly returns null — never fabricated, never
 * cross-substituted from the other market's line.
 */
export function deriveMoundV2FinalResult(
  frozenLine: number | null,
  finalStatValue: number,
): "over" | "under" | "push" | null {
  if (frozenLine == null || !Number.isFinite(frozenLine)) return null;
  if (finalStatValue === frozenLine) return "push";
  return finalStatValue > frozenLine ? "over" : "under";
}

// ─────────────────────────────────────────────────────────────────────────
// Pure: per-prediction grading decision
// ─────────────────────────────────────────────────────────────────────────

export interface MoundV2OfficialStatsLookup {
  gameStatus: GamePitchingBoxScoreGameStatus | null | undefined;
  pitcherLine: GamePitchingBoxScorePitcher | null | undefined;
  pitcherOrderForTeam: string[] | null | undefined;
}

export interface MoundV2GradingInput {
  market: string;
  pitcherId: string;
  frozenLine: number | null;
  officialStats: MoundV2OfficialStatsLookup;
}

export type MoundV2GradingAction =
  | { kind: "hold"; reason: string }
  | { kind: "void"; reason: string }
  | { kind: "grade"; finalStatValue: number; finalResult: "over" | "under" | "push" | null };

const KNOWN_MARKETS = new Set(["pitcher_strikeouts", "pitcher_outs"]);

/**
 * The single pure decision function every grading path (sweep + regrade)
 * funnels through. Never throws — malformed/absent official data always
 * resolves to "hold" (stay pending) rather than a fabricated verdict.
 */
export function computeMoundV2GradingDecision(input: MoundV2GradingInput): MoundV2GradingAction {
  if (!KNOWN_MARKETS.has(input.market)) {
    return { kind: "hold", reason: "unknown_market" };
  }

  const classification = classifyMoundV2GameStatusForGrading(input.officialStats.gameStatus);
  if (classification === "cancelled") {
    return { kind: "void", reason: "game_cancelled" };
  }

  const pitcherLine = input.officialStats.pitcherLine;
  const wholeGameFinal = classification === "final";

  if (!pitcherLine) {
    if (wholeGameFinal) {
      return { kind: "void", reason: "pitcher_no_appearance" };
    }
    return { kind: "hold", reason: "awaiting_pitcher_appearance" };
  }

  const pulled = hasPitcherBeenPulled(input.pitcherId, input.officialStats.pitcherOrderForTeam);
  const outingComplete = wholeGameFinal || pulled;
  if (!outingComplete) {
    return { kind: "hold", reason: "outing_in_progress" };
  }

  const finalStatValue = input.market === "pitcher_outs" ? pitcherLine.outsRecorded : pitcherLine.strikeOuts;
  const finalResult = deriveMoundV2FinalResult(input.frozenLine, finalStatValue);
  return { kind: "grade", finalStatValue, finalResult };
}
