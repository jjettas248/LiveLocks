// ── MLB Inning Window — surfacing helper (LiveLocks Phase 1) ──────────
// Pure mapping from a raw inning number to a canonical UX bucket.
// This file does NOT change engine math, thresholds, or calibration.
// It is consumed only by surfacing layers (view models, sorting, UI
// pills, admin diagnostics).
//
// Why these buckets?
//   Calibration evidence (765/942/139/4708 rows) shows that ROI varies
//   sharply by inning. The product needs to *represent* that variance
//   to the user before we can act on it. This helper is the canonical
//   bucketing used everywhere a "what inning is this signal in?"
//   answer is needed.

export type MlbInningWindow =
  | "all"      // sentinel — only for filter UI, never on a row
  | "early"    // 1, 2, 3
  | "mid"      // 4, 5, 6
  | "late"     // 7+
  | "unknown"; // missing / null / NaN / non-finite / <1

/** Map a raw inning number to its canonical window. */
export function getMlbInningWindow(inning?: number | null): MlbInningWindow {
  if (inning == null) return "unknown";
  if (typeof inning !== "number" || !Number.isFinite(inning)) return "unknown";
  const n = Math.floor(inning);
  if (n < 1) return "unknown";
  if (n <= 3) return "early";
  if (n <= 6) return "mid";
  return "late";
}

/** Short user-facing label for a window. */
export function getMlbInningWindowLabel(window: MlbInningWindow): string {
  switch (window) {
    case "all":     return "All";
    case "early":   return "Early 1–3";
    case "mid":     return "Mid 4–6";
    case "late":    return "Late 7+";
    case "unknown": return "Unknown inning";
  }
}

/**
 * Sort priority for inning-aware ranking.
 * Higher = surfaced first. Late > Early > Mid > Unknown.
 * `all` is the filter sentinel and is never compared against rows.
 */
export function getMlbInningWindowPriority(window: MlbInningWindow): number {
  switch (window) {
    case "late":    return 4;
    case "early":   return 3;
    case "mid":     return 2;
    case "unknown": return 1;
    case "all":     return 0;
  }
}

/**
 * Returns true when the row's window passes the active filter selection.
 * `all` matches everything (including `unknown`).
 * Specific windows match themselves; `unknown` is included only when the
 * caller opts in (admin debug toggle) — we never hide valid signals
 * solely because inning data is missing, so unknown rows should still
 * render under the matching specific filter when caller passes
 * `includeUnknownAsFallback=true`.
 */
export function inningWindowMatchesFilter(
  rowWindow: MlbInningWindow,
  filter: MlbInningWindow,
  includeUnknownAsFallback: boolean = false,
): boolean {
  if (filter === "all") return true;
  if (rowWindow === filter) return true;
  if (rowWindow === "unknown" && includeUnknownAsFallback) return true;
  return false;
}
