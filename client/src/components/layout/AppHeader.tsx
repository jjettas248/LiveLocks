import * as React from "react";
import { Radio, Zap, Star, Settings, RefreshCw, Loader2, Bell, Trophy, BarChart3, Users } from "lucide-react";
import propPulseLogo from "@assets/kuXz_snw_400x400_1772143708894.jpg";
import { Pill } from "@/components/ui/Pill";

type HeaderUser = {
  isAdmin?: boolean;
  subscriptionTier?: string | null;
  playsUsedToday?: number | null;
  email?: string;
} | null | undefined;

export interface AppHeaderProps {
  /** Display label for the active sport ("NBA" | "MLB" | "NCAAB"). */
  sportLabel: string;
  isGamesLoading: boolean;
  liveGamesCount: number;
  user: HeaderUser;
  /** Untyped /api/debug/data-health payload (admin only). */
  dataHealth?: any;
  isSyncingRosters: boolean;
  onSyncRosters: () => void;
  notificationCount: number;
  smsStatus: string;
  /** Ref to the bell glyph so the dashboard can trigger the flash animation. */
  bellRef: React.Ref<SVGSVGElement>;
  onOpenNotifications: () => void;
  parlayCount: number;
  onToggleParlay: () => void;
  onPlaysRemainingClick: () => void;
  onManageSubscription: () => void;
  onOpenAnalytics: () => void;
  onOpenAdmin: () => void;
  onLogout: () => void;
}

const HEALTH_TONE: Record<string, "success" | "warning" | "danger"> = {
  healthy: "success",
  degraded: "warning",
};

const HEALTH_DOT: Record<string, string> = {
  healthy: "bg-green-500",
  degraded: "bg-amber-500",
};

/**
 * App top navigation. Extracted verbatim from dashboard.tsx (behavior preserved)
 * and re-skinned with the premium primitives — larger logo lockup, glass surface,
 * Pill chips for tier/health. All actions are passed in as handlers so this stays
 * presentation-only and the dashboard keeps owning state.
 */
export function AppHeader({
  sportLabel,
  isGamesLoading,
  liveGamesCount,
  user,
  dataHealth,
  isSyncingRosters,
  onSyncRosters,
  notificationCount,
  smsStatus,
  bellRef,
  onOpenNotifications,
  parlayCount,
  onToggleParlay,
  onPlaysRemainingClick,
  onManageSubscription,
  onOpenAnalytics,
  onOpenAdmin,
  onLogout,
}: AppHeaderProps) {
  const healthStatus: string | undefined = dataHealth?.oddsApi?.status;
  const quotaReached =
    dataHealth?.oddsKeyStatus &&
    dataHealth.oddsKeyStatus.exhaustedKeys.length === dataHealth.oddsKeyStatus.totalKeys;

  return (
    <header
      className="border-b border-border/40 bg-background/80 backdrop-blur-xl sticky top-0 z-50"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          className="flex items-center gap-3 cursor-pointer hover:opacity-80 transition-opacity active:opacity-60"
          aria-label="Scroll to top"
          data-testid="button-scroll-to-top"
        >
          <img
            src={propPulseLogo}
            alt="PropPulse"
            className="w-10 h-10 rounded-xl object-cover shadow-surface-glow flex-shrink-0 ring-1 ring-primary/30"
          />
          <div className="flex flex-col leading-none min-w-0">
            <h1 className="text-xl font-bold tracking-tight text-foreground">LiveLocks</h1>
            <span className="text-label mt-0.5 whitespace-nowrap">by PropPulse · {sportLabel}</span>
          </div>
        </button>
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="hidden sm:flex items-center gap-2 text-xs text-muted-foreground">
            <Radio className="w-3 h-3 text-green-500 animate-pulse" />
            <span>
              {isGamesLoading
                ? "Fetching..."
                : `${liveGamesCount} live game${liveGamesCount !== 1 ? "s" : ""}`}
            </span>
          </div>
          {user && !user.isAdmin && !user.subscriptionTier && (
            <button
              data-testid="button-plays-remaining"
              onClick={onPlaysRemainingClick}
              className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-500 text-xs font-medium hover:bg-amber-500/20 transition-colors"
            >
              <Zap className="w-3 h-3" />
              {user.playsUsedToday ?? 0} / 3 today · Resets tomorrow
            </button>
          )}
          {user && user.subscriptionTier && (
            <div className="flex items-center gap-1.5">
              <Pill tone="premium" size="md" icon={<Star />} data-testid="text-subscription-tier">
                {user.subscriptionTier === "elite"
                  ? "All Sports"
                  : user.subscriptionTier === "all"
                  ? "Pro"
                  : user.subscriptionTier}
              </Pill>
              <button
                data-testid="button-manage-subscription"
                onClick={onManageSubscription}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border text-muted-foreground text-xs hover:text-foreground hover:bg-secondary transition-colors"
                title="Manage, cancel, or downgrade your subscription"
                aria-label="Manage subscription — cancel, downgrade, or update payment"
              >
                <Settings className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Manage Plan</span>
              </button>
            </div>
          )}
          {user?.isAdmin && (
            <>
              <button
                onClick={onSyncRosters}
                disabled={isSyncingRosters}
                data-testid="button-sync-rosters"
                title="Pull latest rosters from ESPN to update player team assignments"
                className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary border border-border text-muted-foreground text-xs hover:text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
              >
                {isSyncingRosters ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                Sync Rosters
              </button>
              {dataHealth && (
                <Pill
                  data-testid="text-data-health"
                  size="md"
                  tone={HEALTH_TONE[healthStatus ?? ""] ?? "danger"}
                  className="hidden sm:inline-flex"
                  icon={
                    <span
                      className={`w-2 h-2 rounded-full ${HEALTH_DOT[healthStatus ?? ""] ?? "bg-red-500"}`}
                    />
                  }
                  title={`Odds API: ${healthStatus}${
                    dataHealth.oddsApi.requestsRemaining !== null
                      ? ` — ${dataHealth.oddsApi.requestsRemaining.toLocaleString()} credits left`
                      : ""
                  }${
                    dataHealth.oddsKeyStatus
                      ? ` — ${dataHealth.oddsKeyStatus.totalKeys} keys, ${dataHealth.oddsKeyStatus.exhaustedKeys.length} exhausted`
                      : ""
                  }`}
                >
                  {quotaReached ? "quota reached" : healthStatus}
                </Pill>
              )}
            </>
          )}
          {/* Unified notification bell — opens alert history + push/SMS settings */}
          <button
            data-testid="button-notifications"
            onClick={onOpenNotifications}
            className="relative flex items-center justify-center w-10 h-10 rounded-lg bg-secondary border border-border text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors"
            title="Notifications & alert history"
          >
            <Bell ref={bellRef} className="w-4 h-4" />
            {/* Red dot — unread alert history (highest priority) */}
            {notificationCount > 0 && (
              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-red-500 border border-background" />
            )}
            {/* Amber pulsing dot — SMS not yet configured */}
            {notificationCount === 0 && smsStatus === "unprompted" && (
              <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
                <span
                  className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"
                  style={{ animationDuration: "2s" }}
                />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500" />
              </span>
            )}
            {/* Green dot — SMS opted-in, no new alerts */}
            {notificationCount === 0 && smsStatus === "opted-in" && (
              <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-green-400" />
            )}
          </button>
          <button
            onClick={onToggleParlay}
            data-testid="button-toggle-parlay"
            className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg bg-primary/10 border border-primary/30 text-primary text-sm font-semibold hover:bg-primary/20 transition-colors"
            title="Parlay Slip"
          >
            <Trophy className="w-4 h-4" />
            <span className="hidden sm:inline">Parlay Slip</span>
            {parlayCount > 0 && (
              <span className="bg-primary text-primary-foreground text-xs rounded-full w-5 h-5 flex items-center justify-center">
                {parlayCount}
              </span>
            )}
          </button>
          {user?.isAdmin && (
            <button
              data-testid="link-performance"
              onClick={onOpenAnalytics}
              className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-400 text-xs font-semibold hover:bg-blue-500/20 transition-colors"
              title="Model Performance"
            >
              <BarChart3 className="w-3.5 h-3.5" />
              Analytics
            </button>
          )}
          {user?.isAdmin && (
            <button
              data-testid="link-admin"
              onClick={onOpenAdmin}
              className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-500 text-xs font-semibold hover:bg-amber-500/20 transition-colors"
              title="Admin panel"
            >
              <Settings className="w-3.5 h-3.5" />
              Admin
            </button>
          )}
          {user && (
            <button
              data-testid="button-logout"
              onClick={onLogout}
              className="flex items-center justify-center gap-1.5 w-10 h-10 sm:w-auto sm:h-auto sm:px-3 sm:py-1.5 rounded-lg bg-secondary border border-border text-muted-foreground text-xs hover:text-foreground hover:bg-secondary/80 transition-colors"
              title={user.email}
              aria-label="Sign out"
            >
              <Users className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Sign Out</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
