import { Zap, Bell, ArrowRight, Loader2 } from "lucide-react";

type FreeActivationRailProps = {
  playsUsedToday: number;
  playsLimit?: number;
  onPrimaryCta: () => void;
  onAlertsCta: () => void;
  alertsAvailable?: boolean;
  isPrimaryLoading?: boolean;
};

export function FreeActivationRail({
  playsUsedToday,
  playsLimit = 3,
  onPrimaryCta,
  onAlertsCta,
  alertsAvailable = false,
  isPrimaryLoading = false,
}: FreeActivationRailProps) {
  const playsRemaining = Math.max(0, playsLimit - (playsUsedToday ?? 0));
  const playsExhausted = playsRemaining === 0;

  return (
    <div
      data-testid="panel-free-activation-rail"
      className="rounded-2xl border border-border bg-secondary p-5 sm:p-6 space-y-4"
    >
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-primary/15 border border-primary/30 text-primary text-[10px] font-bold uppercase tracking-wider">
            <Zap className="w-3 h-3" />
            Free
          </span>
          <span
            data-testid="text-plays-status"
            className="text-[11px] font-medium text-muted-foreground"
          >
            {playsExhausted
              ? `0 of ${playsLimit} left today · Resets tomorrow`
              : `${playsUsedToday ?? 0} of ${playsLimit} used today`}
          </span>
        </div>

        <h2
          data-testid="text-activation-headline"
          className="text-xl sm:text-2xl font-bold text-foreground leading-tight"
        >
          Get your {playsLimit} free player prop signals today
        </h2>

        <p
          data-testid="text-activation-supporting"
          className="text-sm text-muted-foreground leading-relaxed"
        >
          LiveLocks highlights MLB and NBA player prop setups driven by live
          game context and signal timing.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-2.5">
        <button
          type="button"
          data-testid="button-best-free-play"
          onClick={onPrimaryCta}
          disabled={isPrimaryLoading}
          aria-label={
            playsExhausted
              ? "All free plays used today — tap to upgrade for unlimited signals"
              : "See today's best free play"
          }
          className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:bg-primary/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {isPrimaryLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Zap className="w-4 h-4" />
          )}
          See Today's Best Free Play
          {!isPrimaryLoading && (
            <ArrowRight className="w-4 h-4" />
          )}
        </button>

        <button
          type="button"
          data-testid="button-get-daily-alerts"
          onClick={onAlertsCta}
          className="inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-border bg-card text-foreground text-sm font-semibold hover:bg-accent transition-colors"
        >
          <Bell className="w-4 h-4" />
          Get Daily Alerts
        </button>
      </div>

      {!alertsAvailable && (
        <p
          data-testid="text-alerts-coming-soon"
          className="text-[11px] text-muted-foreground/80"
        >
          Daily alerts coming soon — tap above to be notified when they go live.
        </p>
      )}
    </div>
  );
}
