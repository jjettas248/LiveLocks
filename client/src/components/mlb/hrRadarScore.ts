import type { HrRadarLadderEntry } from "@/components/mlb/HrRadarLadder";

// Single source of truth for deriving the user-facing 0-10 HR Radar score
// from a ladder entry. Previously each surface (ladder card, share card,
// quick-decide) re-implemented the fallback chain — and the share/quick-decide
// versions used a weaker 2-step chain that blanked scores the ladder showed.
// These helpers reproduce LadderCard's robust fallback so every surface agrees.
//
// Order matters: conviction-aware DISPLAY score first (so the number matches
// the section the engine assigned the row to), then the raw signalScore10, then
// the 0-100 readiness / legacy mirrors divided to the 10-point scale.
const toScore10 = (v: number | null | undefined): number | null =>
  v != null ? Math.round(v) / 10 : null;

export function hrEntryCurrentScore10(entry: HrRadarLadderEntry): number | null {
  return (
    entry.displayCurrentScore10 ??
    entry.currentSignalScore10 ??
    toScore10(entry.currentReadinessScore) ??
    toScore10(entry.signalStrengthScore) ??
    entry.peakSignalScore10 ??
    null
  );
}

export function hrEntryInitialScore10(entry: HrRadarLadderEntry): number | null {
  return (
    entry.displayInitialScore10 ??
    entry.initialSignalScore10 ??
    toScore10(entry.initialReadinessScore) ??
    null
  );
}

export function hrEntryPeakScore10(entry: HrRadarLadderEntry): number | null {
  return (
    entry.displayPeakScore10 ??
    entry.peakSignalScore10 ??
    toScore10(entry.peakReadinessScore) ??
    toScore10(entry.peakScore) ??
    null
  );
}

// ── HR Radar display contract — FORMATTING ONLY. ────────────────────────────
// These read server-stamped fields (see server/mlb/hrRadarDisplayContract.ts)
// and clamp for safety. They must NOT recompute probability, infer the tier, or
// rebuild the action bands — the server owns all of that.

// Guard null/blank FIRST — Number(null) === 0 and Number("") === 0 would
// otherwise coerce a missing value into a false 0 (e.g. "0% HR chance" for a
// row the server intentionally stamped null). Missing must stay null so the UI
// falls back (HR chance → tier-banded strength).
function formatStampedNumber(value: unknown, min: number, max: number, decimals: 0 | 1): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = decimals === 0 ? Math.round(n) : Math.round(n * 10) / 10;
  return Math.max(min, Math.min(max, rounded));
}

export function hrEntryHrChancePct(entry: HrRadarLadderEntry): number | null {
  return formatStampedNumber(entry?.displayHrChancePct, 0, 100, 0);
}

export function hrEntryActionScore10(entry: HrRadarLadderEntry): number | null {
  return formatStampedNumber(entry?.displayActionScore10, 0, 10, 1);
}

export function hrEntryReadinessScore10(entry: HrRadarLadderEntry): number | null {
  return formatStampedNumber(entry?.displayReadinessScore10, 0, 10, 1);
}
