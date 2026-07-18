/**
 * HR Radar — the additive, versioned consumer decision view.
 *
 * Pure, no I/O. Builds the single authoritative `HrRadarDecisionView`
 * (shared/hrRadarDecisionView.ts) from a `storage.getHrRadarLadder()` result.
 * This is the ONE place stage, result classification, action eligibility,
 * ordering, and every displayed count get decided — Quick Decide and Full
 * Ladder both read this verbatim instead of each re-deriving their own
 * (previously-divergent) counts and stage buckets from raw ladder sections.
 *
 * Never mutates the ladder, never touches engine probability/scoring/
 * grading/persistence — purely a read-side normalization layer, same
 * discipline as hrRadarDisplayContract.ts / hrRadarSection.ts.
 */

import type { HrRadarLadderEntry } from "../storage";
import { CALLED_HIT_OUTCOME_STATUSES } from "./hrRadarSection";
import {
  HR_RADAR_DECISION_VIEW_VERSION,
  emptyHrRadarDecisionViewGroups,
  emptyHrRadarDecisionViewCounts,
  degradedHrRadarDecisionView,
  type HrRadarConsumerEntry,
  type HrRadarDecisionView,
  type HrRadarDecisionViewCounts,
  type HrRadarDecisionViewGroups,
  type HrRadarLiveStage,
  type HrRadarConsumerAction,
  type HrRadarResultType,
} from "../../shared/hrRadarDecisionView";

export { degradedHrRadarDecisionView };

type SectionKey = "attackNow" | "ready" | "building" | "watch" | "cashed" | "dead";

export interface HrRadarLadderSectionsInput {
  attackNow?: HrRadarLadderEntry[] | null;
  ready?: HrRadarLadderEntry[] | null;
  building?: HrRadarLadderEntry[] | null;
  watch?: HrRadarLadderEntry[] | null;
  cashed?: HrRadarLadderEntry[] | null;
  dead?: HrRadarLadderEntry[] | null;
}

export interface HrRadarLadderInput {
  sessionDate: string;
  sections: HrRadarLadderSectionsInput;
}

const norm = (v: unknown): string => String(v ?? "").trim().toLowerCase();

// Resolved sections always outrank live ones; among live sections, Fire
// outranks Ready outranks Build outranks Watch. Lower rank wins a conflict.
const SECTION_RANK: Record<SectionKey, number> = {
  cashed: 0,
  dead: 1,
  attackNow: 2,
  ready: 3,
  building: 4,
  watch: 5,
};

const SECTION_ORDER: SectionKey[] = ["cashed", "dead", "attackNow", "ready", "building", "watch"];

function liveStageForSection(sectionKey: SectionKey): HrRadarLiveStage {
  switch (sectionKey) {
    case "attackNow": return "fire";
    case "ready": return "ready";
    case "building": return "build";
    case "watch": return "watch";
    default: return null;
  }
}

/**
 * Is this row an official Fire-tier resolved result? Both branches read
 * ALREADY-GRADED, frozen-at-write-time evidence — neither re-derives
 * `reachedFireCommitment` here, matching hrRadarFireOnlyGrading.test.ts's
 * locked contract exactly rather than reimplementing a parallel heuristic:
 *
 *   - HIT: `outcomeStatus === "called_hit_attack"` (the tiered Fire/Attack
 *     cash — see hrRadarSection.ts's `getCashedFromTierLabel`) or the legacy
 *     untiered `"called_hit"` (pre-tiering rows, which predate the
 *     called_hit_ready/build/watch split and were Attack-only by
 *     construction). `called_hit_ready/build/watch`/`called_near_hr` are
 *     genuine cashes but NOT Fire-tier — routed to model_review, not
 *     signal_hit.
 *   - MISS: `outcome === "miss"` (DB `called_miss`). The storage.ts reconcile
 *     path (grep "[HR_RADAR_READY_NOT_FIRE]") already demotes any
 *     `called_miss` that fails `reachedFireCommitment` to `expired` BEFORE
 *     persisting — so a row that reaches this decision view with outcome
 *     "miss" is, by construction, already Fire-committed.
 *
 * Anything else resolved (uncalled_hr, late_signal,
 * early_hr_insufficient_sample / early_window_hr, expired/unresolved) is
 * real information but not a PROVEN Fire outcome — routed to model_review.
 * Undercount over fabricate: ambiguous history never becomes a counted Fire
 * hit or miss.
 */
function classifyResolvedFire(entry: HrRadarLadderEntry): {
  resultType: HrRadarResultType;
  hasFireCommitment: boolean;
} {
  const outcome = norm(entry.outcome);
  const outcomeStatus = norm(entry.outcomeStatus);

  if (outcome === "called_hit") {
    const isFireTier = outcomeStatus === "called_hit_attack" || outcomeStatus === "called_hit";
    return isFireTier
      ? { resultType: "signal_hit", hasFireCommitment: true }
      : { resultType: "model_review", hasFireCommitment: false };
  }
  if (outcome === "miss") {
    return { resultType: "official_miss", hasFireCommitment: true };
  }
  return { resultType: "model_review", hasFireCommitment: false };
}

const FALLBACK_PROMOTION_REQUIREMENT: Record<"ready" | "build" | "watch", string> = {
  ready: "Waiting for the next qualifying contact event.",
  build: "Needs stronger or repeated contact evidence.",
  watch: "Monitoring early conditions.",
};

/**
 * Prefer an existing specific server-supplied requirement when present;
 * otherwise a stage-safe fallback. These fallbacks are UI explanations, not
 * engine claims — never a single hardcoded global string regardless of
 * stage.
 */
function derivePromotionRequirement(
  entry: HrRadarLadderEntry,
  liveStage: HrRadarLiveStage,
): string | null {
  if (liveStage == null || liveStage === "fire") return null;
  const specific = entry.displayWhyNotTopWindow ?? entry.stageDescription ?? null;
  const cleaned = typeof specific === "string" ? specific.trim() : "";
  if (cleaned.length > 0) return cleaned;
  return FALLBACK_PROMOTION_REQUIREMENT[liveStage];
}

/**
 * Is this a true pregame-only row (no live at-bat context at all — the game
 * hasn't given this player a plate appearance to score on, so the engine
 * necessarily scores it 0/pregame)? Distinct from `waitingForFirstAb`
 * (the game IS live but this player hasn't batted yet) — that case still
 * gets a section (see below); this one is excluded entirely, matching the
 * existing client `isPregameOnlyRow` intent of hiding generic pregame noise.
 */
function isTruePregameOnly(entry: HrRadarLadderEntry): boolean {
  const pa = entry.plateAppearancesTracked ?? 0;
  return pa === 0 && entry.hasLiveABContext !== true;
}

function isWaitingForFirstAb(entry: HrRadarLadderEntry): boolean {
  const pa = entry.plateAppearancesTracked ?? 0;
  return pa === 0 && entry.hasLiveABContext === true;
}

function buildConsumerEntry(
  entry: HrRadarLadderEntry,
  sectionKey: SectionKey,
): HrRadarConsumerEntry<HrRadarLadderEntry> {
  const entryId = `${entry.gameId}:${entry.playerId}`;
  const isFinal = entry.isGameFinal === true;
  const isResolvedSection = sectionKey === "cashed" || sectionKey === "dead";
  const isResolved = entry.currentStatus === "resolved" || isResolvedSection || isFinal;

  if (isResolved) {
    const { resultType, hasFireCommitment } = classifyResolvedFire(entry);
    return {
      entryId,
      source: entry,
      liveStage: null,
      resultType,
      consumerAction: "none",
      isResolved: true,
      hasFireCommitment,
      canAddToSlip: false,
      canWatchNextAb: false,
      promotionRequirement: null,
    };
  }

  const liveStage = liveStageForSection(sectionKey);
  const consumerAction: HrRadarConsumerAction =
    liveStage === "fire" ? "take_now" : liveStage === "ready" ? "watch_next_ab" : "none";

  // HR Radar's bet-slip payload is a fixed synthetic convention (market
  // "home_runs", line 0.5, side OVER — see HrQuickDecide.tsx/HrRadarLadder.tsx
  // handleAdd) rather than a priced market carrying its own isBettable flag,
  // so "valid bet payload" here means real player+game identity — the one
  // thing that would make that synthetic slip payload garbage.
  const hasValidIdentity = Boolean(entry.playerId && entry.playerName && entry.gameId);
  const canAddToSlip = liveStage === "fire" && hasValidIdentity;
  const canWatchNextAb = liveStage === "ready";

  return {
    entryId,
    source: entry,
    liveStage,
    resultType: null,
    consumerAction,
    isResolved: false,
    hasFireCommitment: liveStage === "fire",
    canAddToSlip,
    canWatchNextAb,
    promotionRequirement: derivePromotionRequirement(entry, liveStage),
  };
}

export interface BuildHrRadarDecisionViewOptions {
  logger?: (message: string) => void;
}

/**
 * Build the authoritative decision view from a ladder result. Dedupes by
 * `entryId`; on conflict (the same player+game present in more than one
 * section — should already be a no-op given storage.ts's own dedupe, but
 * guaranteed here too) keeps the stronger canonical section and logs
 * `[HR_RADAR_DECISION_CONFLICT]` unconditionally (never sampled — it
 * indicates a real upstream data problem).
 */
export function buildHrRadarDecisionView(
  ladder: HrRadarLadderInput,
  opts: BuildHrRadarDecisionViewOptions = {},
): HrRadarDecisionView<HrRadarLadderEntry> {
  const log = opts.logger ?? ((message: string) => { console.log(message); });

  const entries: Record<string, HrRadarConsumerEntry<HrRadarLadderEntry>> = {};
  const entryRank: Record<string, number> = {};
  const entrySections: Record<string, SectionKey[]> = {};

  for (const sectionKey of SECTION_ORDER) {
    const rows = ladder.sections[sectionKey] ?? [];
    for (const row of rows) {
      if (row?.gameId == null || row?.playerId == null) continue;
      const entryId = `${row.gameId}:${row.playerId}`;
      entrySections[entryId] = [...(entrySections[entryId] ?? []), sectionKey];

      // Pregame-only rows never enter the live decision surface at all —
      // checked before any conflict bookkeeping so they can't "win" a slot
      // over a genuine live/resolved row for the same entryId.
      const isResolvedSection = sectionKey === "cashed" || sectionKey === "dead";
      if (!isResolvedSection && row.currentStatus !== "resolved" && row.isGameFinal !== true && isTruePregameOnly(row)) {
        continue;
      }

      const rank = SECTION_RANK[sectionKey];
      const priorRank = entryRank[entryId];
      if (priorRank !== undefined && priorRank <= rank) {
        // A stronger (or equal) section already claimed this entryId.
        continue;
      }
      entryRank[entryId] = rank;
      entries[entryId] = buildConsumerEntry(row, sectionKey);
    }
  }

  let conflictCount = 0;
  for (const [entryId, sections] of Object.entries(entrySections)) {
    if (sections.length > 1) {
      conflictCount++;
      const winner = entries[entryId];
      const selected = winner ? (winner.liveStage ?? winner.resultType ?? "excluded_pregame") : "excluded_pregame";
      log(`[HR_RADAR_DECISION_CONFLICT] entryId=${entryId} sectionsFound=${sections.join(",")} sectionSelected=${selected}`);
    }
  }

  const groups: HrRadarDecisionViewGroups = emptyHrRadarDecisionViewGroups();

  for (const [entryId, entry] of Object.entries(entries)) {
    if (entry.isResolved) {
      if (entry.resultType === "signal_hit") groups.signalHits.push(entryId);
      else if (entry.resultType === "official_miss") groups.officialMisses.push(entryId);
      else groups.modelReview.push(entryId);
      continue;
    }
    if (isWaitingForFirstAb(entry.source)) {
      groups.waitingForFirstAb.push(entryId);
      continue;
    }
    if (entry.liveStage === "fire") groups.takeNow.push(entryId);
    else if (entry.liveStage === "ready") groups.watchNextAb.push(entryId);
    else if (entry.liveStage === "build") groups.build.push(entryId);
    else if (entry.liveStage === "watch") groups.watch.push(entryId);
  }

  const counts: HrRadarDecisionViewCounts = {
    ...emptyHrRadarDecisionViewCounts(),
    takeNow: groups.takeNow.length,
    watchNextAb: groups.watchNextAb.length,
    build: groups.build.length,
    watch: groups.watch.length,
    forming: groups.build.length + groups.watch.length,
    waitingForFirstAb: groups.waitingForFirstAb.length,
    liveTracked: groups.takeNow.length + groups.watchNextAb.length + groups.build.length + groups.watch.length,
    fireHitsToday: groups.signalHits.length,
    fireMissesToday: groups.officialMisses.length,
    modelReview: groups.modelReview.length,
  };

  // Routine per-build summary — debug-gated (same convention as the existing
  // DEBUG_HR_RADAR_V1 flag in routes.ts). The ladder route polls every 15s
  // per connected client, so logging this unconditionally would be noise,
  // not signal; [HR_RADAR_DECISION_CONFLICT] above stays always-on since it
  // indicates a real upstream data problem, not routine operation.
  if (process.env.DEBUG_HR_RADAR_DECISION_VIEW === "true") {
    log(
      `[HR_RADAR_DECISION_VIEW] sessionDate=${ladder.sessionDate} takeNow=${counts.takeNow} ` +
      `watchNextAb=${counts.watchNextAb} forming=${counts.forming} fireHitsToday=${counts.fireHitsToday} ` +
      `fireMissesToday=${counts.fireMissesToday} entries=${Object.keys(entries).length} conflicts=${conflictCount}`,
    );
  }

  return {
    version: HR_RADAR_DECISION_VIEW_VERSION,
    status: "ok",
    sessionDate: ladder.sessionDate,
    generatedAt: new Date().toISOString(),
    entries,
    groups,
    counts,
  };
}
