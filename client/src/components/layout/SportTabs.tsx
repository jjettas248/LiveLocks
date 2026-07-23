import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";

type MainTab = "calculator" | "ncaab" | "analytics" | "mlb";
type NbaSubTab = "live" | "halftime";
type MlbSubTab = "live_feed" | "hr_radar" | "pregame_power";

export interface SportTabsProps {
  activeTab: MainTab;
  isAdmin: boolean;
  hasMLB: boolean;
  hasNcaabAccess: boolean;
  hasLiveNba: boolean;
  hasLiveMlb: boolean;
  showNewBadge: boolean;
  onSelectNba: () => void;
  onSelectMlb: () => void;
  onSelectNcaab: () => void;
  onSelectAnalytics: () => void;
  nbaSubTab: NbaSubTab;
  onSelectNbaSubTab: (tab: NbaSubTab) => void;
  mlbSubTab: MlbSubTab;
  onSelectMlbSubTab: (tab: MlbSubTab) => void;
  /** Legacy Home Run Radar tab, retired from normal navigation. Defaults to hidden. */
  showHrRadarTab?: boolean;
}

// Shared base for primary tab buttons. py-2 gives a comfortable mobile tap target.
const TAB_BASE =
  "px-3 sm:px-4 py-2 rounded-lg text-sm font-semibold transition-all relative whitespace-nowrap";
const TAB_ACTIVE = "bg-primary text-primary-foreground border-glow";
const TAB_INACTIVE = "text-muted-foreground hover:text-foreground";

// Sub-tab (segmented control) styling.
const SUB_BASE = "px-4 py-2 rounded-lg text-xs font-semibold transition-all";
const SUB_ACTIVE = "bg-background text-foreground shadow-surface-sm";
const SUB_INACTIVE = "text-muted-foreground hover:text-foreground";

/**
 * The MLB sub-tab list actually rendered. Pulled out as a pure function (not
 * inlined in JSX) so the "HR Radar is retired from navigation by default"
 * contract is directly unit-testable without mounting the component — see
 * hrRadarFeatureFlag.test.ts.
 */
export function getMlbSubTabList(
  showHrRadarTab: boolean,
): ReadonlyArray<{ key: MlbSubTab; label: string }> {
  return [
    { key: "live_feed", label: "Live Edge" },
    ...(showHrRadarTab ? [{ key: "hr_radar" as const, label: "HR Radar" }] : []),
    { key: "pregame_power", label: "Pre-Game" },
  ];
}

/**
 * Sport navigation (primary tabs) + per-sport sub-tabs. Extracted from
 * dashboard.tsx with behavior preserved — all selection/gating runs through the
 * passed handlers, so access rules and modals stay owned by the dashboard.
 */
export function SportTabs({
  activeTab,
  isAdmin,
  hasMLB,
  hasNcaabAccess,
  hasLiveNba,
  hasLiveMlb,
  showNewBadge,
  onSelectNba,
  onSelectMlb,
  onSelectNcaab,
  onSelectAnalytics,
  nbaSubTab,
  onSelectNbaSubTab,
  mlbSubTab,
  onSelectMlbSubTab,
  showHrRadarTab = false,
}: SportTabsProps) {
  return (
    <>
      <div className="flex gap-1 bg-secondary/40 border border-border/60 rounded-xl p-1 w-fit">
        <button
          onClick={onSelectNba}
          data-testid="tab-calculator"
          className={cn(
            TAB_BASE,
            activeTab === "calculator" ? TAB_ACTIVE : TAB_INACTIVE,
            hasLiveNba && activeTab !== "calculator" && "shadow-[0_0_12px_rgba(34,197,94,0.3)]",
          )}
        >
          {hasLiveNba && (
            <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          )}
          🏀 NBA Live
        </button>
        <button
          data-testid="tab-mlb"
          onClick={onSelectMlb}
          className={cn(
            TAB_BASE,
            "flex items-center gap-1.5",
            activeTab === "mlb" ? TAB_ACTIVE : TAB_INACTIVE,
            hasLiveMlb && activeTab !== "mlb" && "shadow-[0_0_12px_rgba(34,197,94,0.3)]",
          )}
        >
          {hasLiveMlb && (
            <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          )}
          <span role="img" aria-label="baseball">
            ⚾
          </span>
          MLB Live
          {!isAdmin && !hasMLB && <Lock className="w-3 h-3 opacity-50" />}
        </button>
        <button
          data-testid="tab-ncaab"
          onClick={onSelectNcaab}
          className={cn(
            TAB_BASE,
            "flex items-center gap-1.5",
            activeTab === "ncaab" ? TAB_ACTIVE : TAB_INACTIVE,
            !hasNcaabAccess && "opacity-60",
          )}
        >
          <span className="relative inline-flex items-center overflow-visible">
            🎓 NCAAB Live
            {hasNcaabAccess && showNewBadge && (
              <span
                data-testid="ncaab-new-badge"
                className="absolute -top-2 -right-5 rounded bg-brand text-background text-[9px] font-bold uppercase leading-none px-1.5 py-0.5 tracking-wider pointer-events-none"
                style={{ animation: "newBadgeScale 300ms cubic-bezier(0.34,1.56,0.64,1) both" }}
              >
                NEW
              </span>
            )}
          </span>
          {!hasNcaabAccess && <Lock className="w-3 h-3 ml-0.5 shrink-0" />}
        </button>
        {isAdmin && (
          <button
            data-testid="tab-analytics"
            onClick={onSelectAnalytics}
            className={cn(
              TAB_BASE,
              "flex items-center gap-1.5",
              activeTab === "analytics" ? TAB_ACTIVE : TAB_INACTIVE,
            )}
          >
            📊 Analytics
          </button>
        )}
      </div>

      {activeTab === "calculator" && (
        <div className="flex gap-1 mt-2 w-fit bg-secondary/40 border border-border/60 rounded-xl p-1">
          <button
            data-testid="tab-nba-live"
            onClick={() => onSelectNbaSubTab("live")}
            className={cn(SUB_BASE, nbaSubTab === "live" ? SUB_ACTIVE : SUB_INACTIVE)}
          >
            Live Props
          </button>
          <button
            data-testid="tab-nba-halftime"
            onClick={() => onSelectNbaSubTab("halftime")}
            className={cn(
              SUB_BASE,
              "flex items-center gap-1.5",
              nbaSubTab === "halftime" ? SUB_ACTIVE : SUB_INACTIVE,
            )}
          >
            ⏱ 2H Plays
          </button>
        </div>
      )}

      {activeTab === "mlb" && (
        <div className="flex gap-1 mt-2 w-fit bg-secondary/40 border border-border/60 rounded-xl p-1">
          {getMlbSubTabList(showHrRadarTab).map((tab) => (
            <button
              key={tab.key}
              data-testid={`tab-mlb-${tab.key}`}
              onClick={() => onSelectMlbSubTab(tab.key)}
              className={cn(
                SUB_BASE,
                mlbSubTab === tab.key ? SUB_ACTIVE : SUB_INACTIVE,
                tab.key === "hr_radar" && mlbSubTab !== "hr_radar" && "relative",
              )}
              style={
                tab.key === "hr_radar" && mlbSubTab === "hr_radar"
                  ? { boxShadow: "0 0 12px rgba(239,68,68,0.3)", borderColor: "rgba(239,68,68,0.3)" }
                  : undefined
              }
            >
              {tab.key === "hr_radar" && (
                <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              )}
              {tab.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
