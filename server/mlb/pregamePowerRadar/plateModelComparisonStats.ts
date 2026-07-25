// The Plate — champion vs challenger outcome analytics.
//
// Pure. Read-only. Modeled on buildAttackEnvironmentEliminationStats: matched
// cohorts, frozen-flag membership, honest denominators.
//
// Three rules this file will not bend:
//
//  1. Exposure is compared sticky-to-sticky — champion `everPubliclyFlagged`
//     against challenger `everPubliclyEligible`. Never the per-build
//     `publicEligible`, never `!suppressed`.
//
//  2. HR and Total Bases are tracked SEPARATELY and never blended. The
//     underlying pregame_win/calibration_miss outcome is HR-based even on a
//     Total-Bases-primary card (see calibrationStats.ts), so the two markets
//     need their own numerators and denominators.
//
//  3. A row with no frozen comparison (built before this shipped, or with
//     shadow disabled) is counted as `challengerUnavailable` — never silently
//     treated as "the challenger declined this candidate", which would
//     manufacture a recall advantage for the champion out of missing data.

import type { PregamePowerSignal } from "./types";
import { isComparisonAvailable, type PlateDeltaAttribution } from "./plateModelComparison";
import { PLATE_CHAMPION_VERSION, PLATE_CHALLENGER_VERSION } from "./modelVersions/plateModelTypes";

export interface PlateMarketRecord {
  calls: number;
  hits: number;
  hitRate: number | null;
}

export interface PlateModelOutcomeRecord {
  publicCandidates: number;
  hr: PlateMarketRecord;
  tb: PlateMarketRecord;
}

export interface PlateModelComparisonReport {
  championVersion: string;
  challengerVersion: string;
  range: { startET: string; endET: string };
  rowsScanned: number;
  /** Rows with no frozen comparison — cannot be attributed to either model. */
  challengerUnavailable: { total: number; disabled: number; failed: number; inputsMissing: number; noRecord: number };
  champion: PlateModelOutcomeRecord;
  challenger: PlateModelOutcomeRecord;
  recall: {
    allSlateHrs: number;
    championCalledHrs: number;
    challengerCalledHrs: number;
    uncalledHrs: number;
  };
  disagreements: {
    total: number;
    championOnly: number;
    challengerOnly: number;
    tierChanges: number;
    marketChanges: number;
  };
  winnerLossAnalysis: {
    /** Champion kept a winner the challenger would have removed. */
    championKeptChallengerRemoved: number;
    /** Challenger added a winner the champion missed. */
    challengerAddedChampionMissed: number;
    bothCalled: number;
    neitherCalled: number;
  };
  attributionBreakdown: Record<string, number>;
  lostWinners: PlateComparisonRow[];
  gainedWinners: PlateComparisonRow[];
  addedLosers: PlateComparisonRow[];
}

export interface PlateComparisonRow {
  signalId: string;
  sessionDate: string;
  batterName: string;
  championTier: string;
  challengerTier: string;
  championScore10: number;
  challengerScore10: number;
  championPublic: boolean;
  challengerPublic: boolean;
  hitHr: boolean | null;
  tbOutcome: string | null;
  attribution: PlateDeltaAttribution[];
}

function rate(hits: number, calls: number): number | null {
  if (calls === 0) return null;
  return Math.round((hits / calls) * 1000) / 10;
}

function emptyRecord(): PlateModelOutcomeRecord {
  return {
    publicCandidates: 0,
    hr: { calls: 0, hits: 0, hitRate: null },
    tb: { calls: 0, hits: 0, hitRate: null },
  };
}

export function buildPlateModelComparisonReport(
  signals: PregamePowerSignal[],
  range: { startET: string; endET: string },
): PlateModelComparisonReport {
  const champion = emptyRecord();
  const challenger = emptyRecord();
  const unavailable = { total: 0, disabled: 0, failed: 0, inputsMissing: 0, noRecord: 0 };
  const disagreements = { total: 0, championOnly: 0, challengerOnly: 0, tierChanges: 0, marketChanges: 0 };
  const winnerLoss = {
    championKeptChallengerRemoved: 0,
    challengerAddedChampionMissed: 0,
    bothCalled: 0,
    neitherCalled: 0,
  };
  const attributionBreakdown: Record<string, number> = {};
  const lostWinners: PlateComparisonRow[] = [];
  const gainedWinners: PlateComparisonRow[] = [];
  const addedLosers: PlateComparisonRow[] = [];

  let allSlateHrs = 0;
  let championCalledHrs = 0;
  let challengerCalledHrs = 0;

  for (const s of signals) {
    const hitHr = s.outcomes?.hitHr ?? null;
    if (hitHr === true) allSlateHrs++;

    // Champion exposure: the durable frozen flag, exactly as every other
    // Plate analytic counts it.
    const championPublic = s.everPubliclyFlagged === true;
    if (championPublic) {
      champion.publicCandidates++;
      if (hitHr === true) championCalledHrs++;
      if (s.primaryMarket === "home_runs") {
        champion.hr.calls++;
        if (hitHr === true) champion.hr.hits++;
      } else if (s.primaryMarket === "total_bases") {
        champion.tb.calls++;
        if (s.outcomes?.tbOutcome === "tb_success") champion.tb.hits++;
      }
    }

    const record = s.diagnostics?.modelComparison;
    if (!isComparisonAvailable(record)) {
      unavailable.total++;
      if (record == null) unavailable.noRecord++;
      else if (record.challengerUnavailable === "disabled") unavailable.disabled++;
      else if (record.challengerUnavailable === "failed") unavailable.failed++;
      else unavailable.inputsMissing++;
      continue;
    }

    // Challenger exposure: the sticky counterpart, so a mid-slate dip does not
    // read as "never called".
    const challengerPublic = record.challenger.everPubliclyEligible === true;
    if (challengerPublic) {
      challenger.publicCandidates++;
      if (hitHr === true) challengerCalledHrs++;
      if (record.challenger.primaryMarket === "home_runs") {
        challenger.hr.calls++;
        if (hitHr === true) challenger.hr.hits++;
      } else if (record.challenger.primaryMarket === "total_bases") {
        challenger.tb.calls++;
        if (s.outcomes?.tbOutcome === "tb_success") challenger.tb.hits++;
      }
    }

    if (record.delta.tierChanged) disagreements.tierChanges++;
    if (record.delta.marketChanged) disagreements.marketChanges++;
    for (const a of record.attribution) {
      attributionBreakdown[a] = (attributionBreakdown[a] ?? 0) + 1;
    }

    const row: PlateComparisonRow = {
      signalId: s.signalId,
      sessionDate: s.sessionDate,
      batterName: s.batterName,
      championTier: record.champion.tier,
      challengerTier: record.challenger.tier,
      championScore10: record.champion.score10,
      challengerScore10: record.challenger.score10,
      championPublic,
      challengerPublic,
      hitHr,
      tbOutcome: s.outcomes?.tbOutcome ?? null,
      attribution: record.attribution.slice(),
    };

    if (championPublic && challengerPublic) winnerLoss.bothCalled++;
    else if (!championPublic && !challengerPublic) winnerLoss.neitherCalled++;

    if (championPublic !== challengerPublic) {
      disagreements.total++;
      if (championPublic) {
        disagreements.championOnly++;
        // Champion kept it, challenger would have dropped it.
        if (hitHr === true) {
          winnerLoss.championKeptChallengerRemoved++;
          lostWinners.push(row);
        }
      } else {
        disagreements.challengerOnly++;
        if (hitHr === true) {
          winnerLoss.challengerAddedChampionMissed++;
          gainedWinners.push(row);
        } else if (hitHr === false) {
          addedLosers.push(row);
        }
      }
    }
  }

  champion.hr.hitRate = rate(champion.hr.hits, champion.hr.calls);
  champion.tb.hitRate = rate(champion.tb.hits, champion.tb.calls);
  challenger.hr.hitRate = rate(challenger.hr.hits, challenger.hr.calls);
  challenger.tb.hitRate = rate(challenger.tb.hits, challenger.tb.calls);

  return {
    championVersion: PLATE_CHAMPION_VERSION,
    challengerVersion: PLATE_CHALLENGER_VERSION,
    range,
    rowsScanned: signals.length,
    challengerUnavailable: unavailable,
    champion,
    challenger,
    recall: {
      allSlateHrs,
      championCalledHrs,
      challengerCalledHrs,
      uncalledHrs: allSlateHrs - Math.max(championCalledHrs, challengerCalledHrs),
    },
    disagreements,
    winnerLossAnalysis: winnerLoss,
    attributionBreakdown,
    lostWinners,
    gainedWinners,
    addedLosers,
  };
}
