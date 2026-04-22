/**
 * Goldmaster HR Radar — Phase 10 validation harness.
 *
 * Asserts the canonical-entity invariants spelled out in the 10-phase repair
 * spec on a live `/api/mlb/hr-radar/ladder` payload. This is intentionally a
 * pure function so it can run from a script, an admin endpoint, or be wired
 * into CI later. Returning `violations: []` means the ladder is structurally
 * sound and the called-vs-uncalled integrity contract is intact.
 */

import type { HrRadarLadderEntry } from "../../storage";

export interface LadderInvariantViolation {
  code: string;
  message: string;
  playerId: string;
  gameId: string;
  section: string;
}

export interface LadderInvariantReport {
  totalRows: number;
  liveRows: number;
  resolvedRows: number;
  violations: LadderInvariantViolation[];
}

const ENGINE_JARGON_RE =
  /(PATH[_ ]?[A-Z0-9_]+|WATCH:|BUILD:|FORM:|PRE[_ ]HR[_ ]DANGER|HrShaped|BsZ|Score\d|Conv\s+\d+%|Profile\d|Danger\d)/i;

/**
 * Validate a ladder payload against the Goldmaster invariants.
 *
 * Invariants enforced:
 *  I1  Every row carries currentStage AND currentStatus AND outcome.
 *  I2  Live rows MUST have outcome === "pending".
 *  I3  Resolved rows MUST NOT have outcome === "pending".
 *  I4  Resolved rows live ONLY in `cashed` or `dead` sections.
 *  I5  `cashed` section is exclusively outcome === "called_hit".
 *  I6  `early_window_hr` rows live in `dead`, NEVER blended with `miss`/`uncalled_hr`.
 *  I7  Live rows with hasLiveABContext === false MUST have plateAppearancesTracked === 0
 *      (no "live AB" rendering on a 0-AB pregame-only signal).
 *  I8  No userReason string contains raw engine jargon (PATH_*, BsZ, Score#, etc.).
 *  I9  Live rows MUST be in attackNow|building|watch.
 *  I10 currentStage on live attackNow rows MUST be "attack"; building → "building";
 *      watch → "watch" or "cooling" (cooling is allowed but only in watch).
 */
export function validateHrRadarLadder(payload: {
  sections: Record<string, HrRadarLadderEntry[]>;
}): LadderInvariantReport {
  const violations: LadderInvariantViolation[] = [];
  let totalRows = 0;
  let liveRows = 0;
  let resolvedRows = 0;

  const push = (
    code: string,
    message: string,
    e: HrRadarLadderEntry,
    section: string,
  ) => {
    violations.push({
      code,
      message,
      playerId: e.playerId,
      gameId: e.gameId,
      section,
    });
  };

  for (const [section, entries] of Object.entries(payload.sections)) {
    for (const e of entries) {
      totalRows++;
      const isResolvedSection = section === "cashed" || section === "dead";
      const isLiveSection = section === "attackNow" || section === "building" || section === "watch";

      // I1
      if (!e.currentStage || !e.currentStatus || !e.outcome) {
        push("I1_MISSING_CANONICAL_FIELDS",
          `Row missing currentStage/currentStatus/outcome (got stage=${e.currentStage} status=${e.currentStatus} outcome=${e.outcome})`,
          e, section);
        continue;
      }

      if (e.currentStatus === "live") liveRows++;
      else resolvedRows++;

      // I2 / I3
      if (e.currentStatus === "live" && e.outcome !== "pending") {
        push("I2_LIVE_NON_PENDING_OUTCOME",
          `Live row has non-pending outcome=${e.outcome}`, e, section);
      }
      if (e.currentStatus === "resolved" && e.outcome === "pending") {
        push("I3_RESOLVED_PENDING_OUTCOME",
          "Resolved row carries outcome=pending", e, section);
      }

      // I4
      if (e.currentStatus === "resolved" && !isResolvedSection) {
        push("I4_RESOLVED_IN_LIVE_SECTION",
          `Resolved row placed in live section ${section}`, e, section);
      }
      if (e.currentStatus === "live" && isResolvedSection) {
        push("I4b_LIVE_IN_RESOLVED_SECTION",
          `Live row placed in resolved section ${section}`, e, section);
      }

      // I5
      if (section === "cashed" && e.outcome !== "called_hit") {
        push("I5_CASHED_NON_CALLED_HIT",
          `cashed section row has outcome=${e.outcome}`, e, section);
      }

      // I6
      if (e.outcome === "early_window_hr" && section !== "dead") {
        push("I6_EARLY_WINDOW_HR_WRONG_SECTION",
          `early_window_hr row placed in section=${section} (must be dead)`, e, section);
      }
      // The legacy DB value early_hr_no_window must always surface as
      // outcome=early_window_hr (Phase 4 mapping). If outcomeStatus is
      // early_hr_no_window but outcome is something else, the mapping is broken.
      if (e.outcomeStatus === "early_hr_no_window" && e.outcome !== "early_window_hr") {
        push("I6b_EARLY_WINDOW_MAPPING_BROKEN",
          `outcomeStatus=early_hr_no_window did not map to outcome=early_window_hr (got ${e.outcome})`,
          e, section);
      }

      // I7
      if (e.currentStatus === "live") {
        const pa = e.plateAppearancesTracked;
        if (e.hasLiveABContext === false && pa != null && pa > 0) {
          push("I7_AB_CONTEXT_INCONSISTENT",
            `hasLiveABContext=false but plateAppearancesTracked=${pa}`, e, section);
        }
      }

      // I8
      for (const r of e.userReasons ?? []) {
        if (ENGINE_JARGON_RE.test(r)) {
          push("I8_ENGINE_JARGON_LEAK",
            `userReason contains engine jargon: "${r}"`, e, section);
          break;
        }
      }

      // I9
      if (e.currentStatus === "live" && !isLiveSection) {
        push("I9_LIVE_OUTSIDE_LIVE_SECTIONS",
          `Live row in unexpected section ${section}`, e, section);
      }

      // I10
      if (e.currentStatus === "live") {
        if (section === "attackNow" && e.currentStage !== "attack") {
          push("I10_ATTACK_SECTION_STAGE_MISMATCH",
            `attackNow row has currentStage=${e.currentStage}`, e, section);
        }
        if (section === "building" && e.currentStage !== "building") {
          push("I10_BUILDING_SECTION_STAGE_MISMATCH",
            `building row has currentStage=${e.currentStage}`, e, section);
        }
        if (section === "watch" && e.currentStage !== "watch" && e.currentStage !== "cooling") {
          push("I10_WATCH_SECTION_STAGE_MISMATCH",
            `watch row has currentStage=${e.currentStage}`, e, section);
        }
      }

      // I11 — single-scale invariant: current readiness must never exceed
      // peak readiness. Catches the legacy "Initial 10 / Peak 100" mixed-
      // scale class of bug at the wire layer.
      if (
        e.signalStrengthScore != null &&
        e.peakScore != null &&
        e.signalStrengthScore - e.peakScore > 0.5
      ) {
        push("I11_CURRENT_EXCEEDS_PEAK",
          `signalStrengthScore=${e.signalStrengthScore} exceeds peakScore=${e.peakScore}`,
          e, section);
      }

      // I12 — peak readiness must live on the canonical 0-100 scale.
      if (e.peakScore != null && (e.peakScore < 0 || e.peakScore > 100)) {
        push("I12_PEAK_OUT_OF_SCALE",
          `peakScore=${e.peakScore} outside canonical 0-100 scale`,
          e, section);
      }
    }
  }

  return { totalRows, liveRows, resolvedRows, violations };
}
