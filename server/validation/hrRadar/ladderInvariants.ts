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

      // ── Goldmaster Phase 10 (extended) ─────────────────────────────────────
      // I13 — explicit canonical readiness fields. Same monotonic + scale
      // invariants enforced on the NEW explicit fields the wire now exposes.
      if (
        e.currentReadinessScore != null &&
        e.peakReadinessScore != null &&
        e.currentReadinessScore - e.peakReadinessScore > 0.5
      ) {
        push("I13_CURRENT_READINESS_EXCEEDS_PEAK_READINESS",
          `currentReadinessScore=${e.currentReadinessScore} exceeds peakReadinessScore=${e.peakReadinessScore}`,
          e, section);
      }
      if (e.peakReadinessScore != null && (e.peakReadinessScore < 0 || e.peakReadinessScore > 100)) {
        push("I13b_PEAK_READINESS_OUT_OF_SCALE",
          `peakReadinessScore=${e.peakReadinessScore} outside canonical 0-100 scale`,
          e, section);
      }
      if (e.currentReadinessScore != null && (e.currentReadinessScore < 0 || e.currentReadinessScore > 100)) {
        push("I13c_CURRENT_READINESS_OUT_OF_SCALE",
          `currentReadinessScore=${e.currentReadinessScore} outside canonical 0-100 scale`,
          e, section);
      }
      if (e.initialReadinessScore != null && (e.initialReadinessScore < 0 || e.initialReadinessScore > 100)) {
        push("I13d_INITIAL_READINESS_OUT_OF_SCALE",
          `initialReadinessScore=${e.initialReadinessScore} outside canonical 0-100 scale`,
          e, section);
      }

      // I14 — attack-stage rows must NEVER carry watch/building copy in the
      // canonical stageExplanation. Catches stale or mis-bucketed copy.
      if (e.currentStatus === "live" && e.currentStage === "attack" && e.stageExplanation) {
        const txt = e.stageExplanation.toLowerCase();
        if (txt.includes("monitoring for escalation") || txt.includes("not yet at the building threshold") || txt.includes("the hr pattern is building")) {
          push("I14_ATTACK_ROW_HAS_NON_ATTACK_COPY",
            `attack-stage row has non-attack stageExplanation: "${e.stageExplanation}"`,
            e, section);
        }
      }

      // I15 — zero-AB pregame rows must NOT render any contact-derived
      // reasons. The server's headlineReason for these rows is a fixed
      // pregame string, and supportingReasons should be empty.
      if (e.currentStatus === "live") {
        const isPregameOnly =
          e.hasLiveABContext === false ||
          (e.plateAppearancesTracked != null && e.plateAppearancesTracked === 0);
        if (isPregameOnly && (e.supportingReasons ?? []).length > 0) {
          push("I15_PREGAME_HAS_LIVE_CONTACT_REASONS",
            `pregame zero-AB row has supportingReasons=[${(e.supportingReasons ?? []).join(", ")}]`,
            e, section);
        }
        // The headline must explicitly call out pregame-context-only when the
        // row truly has no live AB evidence.
        if (isPregameOnly && e.headlineReason && !/pregame/i.test(e.headlineReason)) {
          push("I15b_PREGAME_HEADLINE_NOT_PREGAME",
            `pregame zero-AB row has non-pregame headlineReason="${e.headlineReason}"`,
            e, section);
        }
      }

      // I16 — detection vs HR-event truth must remain distinct fields.
      // If a row is resolved as called_hit and has a hitLabel, detectedLabel
      // must still be populated (the FROZEN first-detection inning), and the
      // two should not be the same string unless the engine genuinely first
      // saw the player in the same inning the HR landed.
      if (e.outcome === "called_hit" && e.hitLabel && !e.detectedLabel) {
        push("I16_CALLED_HIT_MISSING_DETECTED_LABEL",
          `called_hit row has hitLabel=${e.hitLabel} but no detectedLabel (frozen detection inning lost)`,
          e, section);
      }

      // ── Goldmaster RESTORE — 10-point USER-FACING wire invariants. ────────
      // The user surface renders the 0.0-10.0 score (one decimal) as the
      // primary number. The internal 0-100 scale stays in storage. These
      // invariants assert the wire shape and momentum metadata are sound.

      // I17 — currentSignalScore10 is in the 0.0-10.0 range with at most one
      // decimal of precision (server rounds via Math.round(x*10)/10 etc).
      const has10pt =
        e.currentSignalScore10 !== undefined ||
        e.peakSignalScore10 !== undefined ||
        e.initialSignalScore10 !== undefined;
      if (has10pt) {
        const check10 = (val: number | null | undefined, code: string, name: string) => {
          if (val == null) return;
          if (val < 0 || val > 10) {
            push(code, `${name}=${val} outside user-facing 0.0-10.0 scale`, e, section);
            return;
          }
          // Allow tiny FP slop on the rounding check.
          const scaled = val * 10;
          if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
            push(code, `${name}=${val} has more than 1 decimal of precision`, e, section);
          }
        };
        check10(e.currentSignalScore10, "I17a_CURRENT10_BAD", "currentSignalScore10");
        check10(e.peakSignalScore10, "I17b_PEAK10_BAD", "peakSignalScore10");
        check10(e.initialSignalScore10, "I17c_INITIAL10_BAD", "initialSignalScore10");

        // I18 — peak10 >= current10 (within 0.05 tolerance for FP rounding).
        if (
          e.currentSignalScore10 != null &&
          e.peakSignalScore10 != null &&
          e.peakSignalScore10 < e.currentSignalScore10 - 0.05
        ) {
          push("I18_PEAK10_BELOW_CURRENT10",
            `peakSignalScore10=${e.peakSignalScore10} < currentSignalScore10=${e.currentSignalScore10}`,
            e, section);
        }

        // I19 — momentumLabel must be in the allowed enum set.
        if (e.momentumLabel != null) {
          const allowed = new Set(["heating_up", "holding_strong", "cooling_off", "flat"]);
          if (!allowed.has(e.momentumLabel)) {
            push("I19_MOMENTUM_LABEL_INVALID",
              `momentumLabel="${e.momentumLabel}" not in allowed set`,
              e, section);
          }
        }

        // I20 — heating_up and cooling_off are mutually exclusive.
        if (e.isHeatingUp === true && e.isCoolingOff === true) {
          push("I20_HEATING_AND_COOLING",
            `row has both isHeatingUp=true AND isCoolingOff=true`,
            e, section);
        }
      }

      // ── Goldmaster Detection Ledger (Phase 11) — ledger truth invariants ──
      // I21 — A called_hit row MUST carry a frozen first-detection inning.
      // Without detectedInning the row never qualified, so it cannot be a
      // legitimate called hit.
      if (e.outcome === "called_hit") {
        if (e.detectedInning == null || e.detectedHalf == null || !e.detectedLabel) {
          push("I21_CALLED_HIT_MISSING_DETECTION",
            `called_hit row missing frozen detection (inning=${e.detectedInning} half=${e.detectedHalf} label=${e.detectedLabel})`,
            e, section);
        }
      }

      // I22 — For called_hit rows with both timestamps populated, the
      // signal MUST predate the HR. Late signals must NOT be in cashed.
      if (
        e.outcome === "called_hit" &&
        e.signalDetectedAt &&
        e.hitDetectedAt
      ) {
        const sigMs = new Date(e.signalDetectedAt).getTime();
        const hitMs = new Date(e.hitDetectedAt).getTime();
        if (Number.isFinite(sigMs) && Number.isFinite(hitMs) && sigMs >= hitMs) {
          push("I22_SIGNAL_NOT_BEFORE_HR",
            `called_hit row has signalDetectedAt(${e.signalDetectedAt}) >= hitDetectedAt(${e.hitDetectedAt})`,
            e, section);
        }
      }

      // I23 — detectedInning must NEVER be after hitInning (no detection-
      // after-HR). Catches Vargas/Montgomery-style "detected B5, HR was B3"
      // contradictions.
      if (
        e.detectedInning != null &&
        e.hitInning != null &&
        e.detectedInning > e.hitInning
      ) {
        push("I23_DETECTION_AFTER_HR",
          `detectedInning=${e.detectedHalf}${e.detectedInning} is AFTER hitInning=${e.hitHalf}${e.hitInning}`,
          e, section);
      }

      // I24 — outcomeStatus is one of the canonical values. Any unexpected
      // value indicates a leak from a legacy code path.
      if (e.outcomeStatus) {
        const allowedStatuses = new Set([
          "active",
          "called_hit",
          "called_miss",
          "uncalled_hr",
          "late_signal",
          "early_hr_no_window",
          "early_window_hr",
        ]);
        if (!allowedStatuses.has(e.outcomeStatus)) {
          push("I24_UNKNOWN_OUTCOME_STATUS",
            `outcomeStatus="${e.outcomeStatus}" not in canonical set`,
            e, section);
        }
      }

      // I25 — A late_signal row must have BOTH detection and hit timestamps
      // and the detection must be at or after the HR (definition of late).
      // Tolerance: within ±2s the timestamps can be the same engine tick;
      // only flag when the signal is meaningfully earlier than the HR.
      if (e.outcome === "late_signal" && e.signalDetectedAt && e.hitDetectedAt) {
        const sigMs = new Date(e.signalDetectedAt).getTime();
        const hitMs = new Date(e.hitDetectedAt).getTime();
        const TICK_TOLERANCE_MS = 2000;
        if (Number.isFinite(sigMs) && Number.isFinite(hitMs) && hitMs - sigMs > TICK_TOLERANCE_MS) {
          push("I25_LATE_SIGNAL_ACTUALLY_PRE_HR",
            `late_signal row has signalDetectedAt(${e.signalDetectedAt}) < hitDetectedAt(${e.hitDetectedAt}) by ${hitMs - sigMs}ms — should be called_hit`,
            e, section);
        }
      }
    }
  }

  return { totalRows, liveRows, resolvedRows, violations };
}
