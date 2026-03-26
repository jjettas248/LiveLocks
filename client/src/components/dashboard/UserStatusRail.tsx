import { usePublicAnalytics } from "@/hooks/usePublicAnalytics";
import { useLiveSignalCounts } from "@/hooks/useLiveSignalCounts";

type UserStatusRailProps = {
  tier: string;
  playsUsed: number;
  playsLimit: number;
  isAdmin?: boolean;
  onUpgradeClick?: () => void;
};

const TIER_LABELS: Record<string, { label: string; color: string }> = {
  free: { label: "Free", color: "bg-muted text-muted-foreground" },
  all: { label: "Pro", color: "bg-blue-500/15 text-blue-400" },
  elite: { label: "All Sports", color: "bg-primary/15 text-primary" },
};

export function UserStatusRail({ tier, playsUsed, playsLimit, isAdmin, onUpgradeClick }: UserStatusRailProps) {
  const { data: analytics } = usePublicAnalytics(!!isAdmin);
  const { data: counts } = useLiveSignalCounts();

  const tierInfo = TIER_LABELS[tier] ?? TIER_LABELS.free;
  const totalLive = counts?.totalLive ?? 0;
  const winRate = analytics?.last7Days?.winRate ?? 0;

  return (
    <div className="rounded-xl border border-border/40 bg-card p-3 space-y-2" data-testid="panel-user-status">
      <div className="flex items-center justify-between">
        <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${tierInfo.color}`}>
          {tierInfo.label}
        </span>
        {tier === "free" && onUpgradeClick && (
          <button
            data-testid="button-status-upgrade"
            onClick={onUpgradeClick}
            className="text-[10px] font-semibold text-primary hover:text-primary/80 transition-colors"
          >
            Upgrade →
          </button>
        )}
      </div>

      <div className={`grid ${isAdmin ? "grid-cols-3" : "grid-cols-2"} gap-2 text-center`}>
        <div>
          <div className="text-[9px] text-muted-foreground">Plays</div>
          <div className="text-xs font-bold text-foreground">
            {tier === "free" ? `${playsUsed}/${playsLimit}` : "∞"}
          </div>
        </div>
        <div>
          <div className="text-[9px] text-muted-foreground">Live Signals</div>
          <div className="text-xs font-bold text-foreground">{totalLive}</div>
        </div>
        {isAdmin && (
          <div>
            <div className="text-[9px] text-muted-foreground">7d Win</div>
            <div className={`text-xs font-bold ${winRate >= 55 ? "text-green-400" : "text-foreground"}`}>{winRate}%</div>
          </div>
        )}
      </div>
    </div>
  );
}
