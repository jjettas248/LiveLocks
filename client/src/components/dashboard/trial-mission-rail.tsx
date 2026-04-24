import { Crown, Bell, ArrowRight, CheckCircle2, Circle, Calendar, Loader2 } from "lucide-react";

type TrialMissionRailProps = {
  trialStartedAt?: string | null;
  trialEndsAt?: string | null;
  plan?: string | null;
  emailVerified?: boolean;
  sportFocus?: string | null;
  alertsConnected?: boolean;
  alertsAvailable?: boolean;
  onOpenBestSignal: () => void;
  onAlertsCta: () => void;
  isPrimaryLoading?: boolean;
};

const PLAN_LABELS: Record<string, string> = {
  all: "All Sports Pro",
  elite: "Elite",
  mlb: "MLB Pro",
  nba: "NBA Pro",
  ncaab: "NCAAB Pro",
};

function formatPlan(tier: string | null | undefined): string {
  if (!tier) return "Pro";
  return PLAN_LABELS[tier] ?? tier.charAt(0).toUpperCase() + tier.slice(1);
}

function formatRenewal(iso: string | null | undefined): { date: string; time: string } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return { date, time };
}

function computeTrialDay(startedAt: string | null | undefined, endsAt: string | null | undefined):
  { day: number | null; total: number | null } {
  if (!startedAt) return { day: null, total: null };
  const start = new Date(startedAt);
  if (Number.isNaN(start.getTime())) return { day: null, total: null };
  const now = new Date();
  const dayMs = 86400000;
  const day = Math.max(1, Math.floor((now.getTime() - start.getTime()) / dayMs) + 1);
  if (!endsAt) return { day, total: null };
  const end = new Date(endsAt);
  if (Number.isNaN(end.getTime())) return { day, total: null };
  const total = Math.max(1, Math.round((end.getTime() - start.getTime()) / dayMs));
  return { day: Math.min(day, total), total };
}

export function TrialMissionRail({
  trialStartedAt,
  trialEndsAt,
  plan,
  emailVerified = false,
  sportFocus = null,
  alertsConnected = false,
  alertsAvailable = false,
  onOpenBestSignal,
  onAlertsCta,
  isPrimaryLoading = false,
}: TrialMissionRailProps) {
  const planLabel = formatPlan(plan);
  const renewal = formatRenewal(trialEndsAt);
  const { day, total } = computeTrialDay(trialStartedAt, trialEndsAt);

  // Missing-actions checklist. Each item degrades gracefully when the underlying field
  // is unavailable (e.g. alerts not yet implemented per PASS 7).
  const checklist: Array<{ id: string; label: string; done: boolean; show: boolean }> = [
    {
      id: "verify-email",
      label: "Verify your email",
      done: !!emailVerified,
      show: true,
    },
    {
      id: "pick-sport",
      label: "Pick your sport focus",
      done: !!sportFocus,
      show: true,
    },
    {
      id: "connect-alerts",
      label: "Connect daily alerts",
      done: !!alertsConnected,
      show: alertsAvailable,
    },
  ];
  const visible = checklist.filter((c) => c.show);

  return (
    <div
      data-testid="panel-trial-mission-rail"
      className="rounded-2xl border border-border bg-secondary p-5 sm:p-6 space-y-4"
    >
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-primary/15 border border-primary/30 text-primary text-[10px] font-bold uppercase tracking-wider">
            <Crown className="w-3 h-3" />
            {planLabel} Trial
          </span>
          {day !== null && (
            <span
              data-testid="text-trial-day"
              className="text-[11px] font-medium text-muted-foreground"
            >
              {total ? `Day ${day} of ${total}` : `Day ${day}`}
            </span>
          )}
        </div>

        <h2
          data-testid="text-trial-headline"
          className="text-xl sm:text-2xl font-bold text-foreground leading-tight"
        >
          Make your {planLabel} trial count
        </h2>

        {renewal ? (
          <p
            data-testid="text-trial-renewal"
            className="text-sm text-muted-foreground leading-relaxed flex items-center gap-1.5"
          >
            <Calendar className="w-3.5 h-3.5 shrink-0" />
            <span>
              Renews <span className="font-semibold text-foreground">{renewal.date}</span> at{" "}
              <span className="font-semibold text-foreground">{renewal.time}</span>
            </span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground leading-relaxed">
            Your {planLabel} trial is active. Use these next steps to get the most out of it.
          </p>
        )}
      </div>

      {visible.length > 0 && (
        <ul
          data-testid="list-trial-checklist"
          className="space-y-1.5 rounded-xl border border-border/60 bg-card p-3"
        >
          {visible.map((item) => (
            <li
              key={item.id}
              data-testid={`checklist-${item.id}`}
              className="flex items-center gap-2 text-[12px]"
            >
              {item.done ? (
                <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
              ) : (
                <Circle className="w-4 h-4 text-muted-foreground/60 shrink-0" />
              )}
              <span
                className={
                  item.done
                    ? "text-muted-foreground line-through"
                    : "text-foreground font-medium"
                }
              >
                {item.label}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col sm:flex-row gap-2.5">
        <button
          type="button"
          data-testid="button-open-best-signal"
          onClick={onOpenBestSignal}
          disabled={isPrimaryLoading}
          className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:bg-primary/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {isPrimaryLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Crown className="w-4 h-4" />
          )}
          Open Best Signal
          {!isPrimaryLoading && <ArrowRight className="w-4 h-4" />}
        </button>

        <button
          type="button"
          data-testid="button-trial-get-daily-alerts"
          onClick={onAlertsCta}
          className="inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-border bg-card text-foreground text-sm font-semibold hover:bg-accent transition-colors"
        >
          <Bell className="w-4 h-4" />
          Get Daily Alerts
        </button>
      </div>

      {!alertsAvailable && (
        <p
          data-testid="text-trial-alerts-coming-soon"
          className="text-[11px] text-muted-foreground/80"
        >
          Daily alerts coming soon.
        </p>
      )}
    </div>
  );
}
