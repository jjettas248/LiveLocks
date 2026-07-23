// Single source of truth for whether the legacy Home Run Radar tab/UI is
// reachable by normal users. Consolidation PR 1: Live Edge is the sole
// public HR experience; the Radar UI is retired but its component tree and
// this flag are kept for instant rollback (flip to true to restore).
export const SHOW_HR_RADAR_TAB = false;

/**
 * The actual render guard for the HR Radar sub-tab content in mlb-live.tsx.
 * Requiring `showHrRadarTab` here (not just omitting the nav chip) means the
 * legacy UI cannot mount even if `activeSubTab` is somehow forced to
 * "hr_radar" by stale state, devtools, or a future deep-link path.
 */
export function shouldMountHrRadarTab(
  activeSubTab: "live_feed" | "hr_radar" | "pregame_power",
  showHrRadarTab: boolean,
): boolean {
  return activeSubTab === "hr_radar" && showHrRadarTab;
}
