import { Crown, Star, Zap, type LucideIcon } from "lucide-react";
import { usePublicAnalytics } from "@/hooks/usePublicAnalytics";
import { useLiveSignalCounts } from "@/hooks/useLiveSignalCounts";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { StatBlock } from "@/components/ui/StatBlock";
import { Pill } from "@/components/ui/Pill";

type UserStatusRailProps = {
  tier: string;
  playsUsed: number;
  playsLimit: number;
  isAdmin?: boolean;
  onUpgradeClick?: () => void;
};

type TierInfo = { label: string; icon: LucideIcon; tone: "muted" | "info" | "premium" };

const TIER_LABELS: Record<string, TierInfo> = {
  free: { label: "Free", icon: Zap, tone: "muted" },
  all: { label: "Pro", icon: Star, tone: "info" },
  elite: { label: "All Sports", icon: Crown, tone: "premium" },
};

export function UserStatusRail({ tier, playsUsed, playsLimit, isAdmin, onUpgradeClick }: UserStatusRailProps) {
  const { data: analytics } = usePublicAnalytics(!!isAdmin);
  const { data: counts } = useLiveSignalCounts();

  const tierInfo = TIER_LABELS[tier] ?? TIER_LABELS.free;
  const TierIcon = tierInfo.icon;
  const totalLive = counts?.totalLive ?? 0;
  const winRate = analytics?.last7Days?.winRate ?? 0;

  return (
    <SurfaceCard variant="elevated" className="p-3.5 space-y-3" data-testid="panel-user-status">
      <div className="flex items-center justify-between">
        <Pill tone={tierInfo.tone} icon={<TierIcon />}>
          {tierInfo.label}
        </Pill>
        {tier === "free" && onUpgradeClick && (
          <button
            data-testid="button-status-upgrade"
            onClick={onUpgradeClick}
            className="text-micro font-semibold text-primary hover:text-primary/80 transition-colors"
          >
            Upgrade →
          </button>
        )}
      </div>

      <div className={`grid ${isAdmin ? "grid-cols-3" : "grid-cols-2"} gap-3`}>
        <StatBlock
          align="center"
          label="Plays"
          value={tier === "free" ? `${playsUsed}/${playsLimit}` : "∞"}
          valueClassName="text-base"
        />
        <StatBlock align="center" label="Live Signals" value={totalLive} valueClassName="text-base" />
        {isAdmin && (
          <StatBlock
            align="center"
            label="7d Win"
            value={`${winRate}%`}
            tone={winRate >= 55 ? "success" : "default"}
            valueClassName="text-base"
            title="Core Engine 7d Win Rate — excludes home_runs and batter_strikeouts (see HR Radar for those)."
            data-testid="tile-status-winrate"
          />
        )}
      </div>
    </SurfaceCard>
  );
}
