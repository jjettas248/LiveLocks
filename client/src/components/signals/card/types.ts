// Shared prop shapes for the "trader argument" card sections. These are pure
// presentation types — callers map their own server-stamped fields (MLBSignal,
// UnifiedTopPlay, HrRadarCardViewModel) onto these shapes once per card. No
// section here computes a probability, edge, grade, or driver — every value is
// passed in already-decided by the server (CLAUDE.md §3.3/§3.5 — UI renders,
// never re-derives).

export interface DriverItem {
  /** Server-built human-readable label, e.g. "Elite Barrel Contact". */
  label: string;
  /** Server-relative importance 0-100, used only to rank/size the bar. Optional. */
  weight?: number | null;
  /** Optional one-line elaboration, server-built. */
  detail?: string | null;
}

export interface LiveContextItem {
  label: string;
  value: string;
  tone?: "default" | "good" | "bad";
}
