import { cn } from "@/lib/utils";
import { tierBadgeClasses } from "@/lib/uiTokens";

/**
 * Signal-tier pill (elite / strong / value / watch).
 *
 * Routes all tier colouring through `tierBadgeClasses` (uiTokens.ts → CSS vars)
 * so the ~40 hand-rolled `text-[10px] font-bold px-2 py-0.5 rounded-full` badges
 * across the MLB/NCAAB cards and admin panels share one source of truth.
 */
export function TierBadge({
  tier,
  label,
  className,
  "data-testid": testId,
}: {
  tier: string | null | undefined;
  label?: string;
  className?: string;
  "data-testid"?: string;
}) {
  const text = label ?? (tier ?? "").toString().toUpperCase();
  return (
    <span
      data-testid={testId}
      className={cn(
        "inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border uppercase tracking-wide",
        tierBadgeClasses(tier),
        className,
      )}
    >
      {text}
    </span>
  );
}
